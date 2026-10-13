import { describe, expect, it } from 'vitest'
import { attachmentFromDriveFile, fileIdFromDriveLink, MULTIPART_LIMIT, uploadFile } from './drive-api'
import { bodyText, fakeFetch, json } from './fake-fetch'
import { createGoogleClient, GoogleError } from './http'
import type { DriveFile } from './types'

function setup(...replies: Parameters<typeof fakeFetch>) {
    const fetch = fakeFetch(...replies)
    const client = createGoogleClient({ tokens: { token: async () => 'token-1', refresh: async () => 'token-2' }, fetch, sleep: async () => {} })
    return { fetch, client }
}

const uploaded: DriveFile = {
    id: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    name: 'Garden plan.txt',
    mimeType: 'text/plain',
    webViewLink: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=drivesdk',
    iconLink: 'https://drive-thirdparty.googleusercontent.com/16/type/text/plain',
}

describe('uploadFile', () => {
    it('sends a small file in one multipart request: metadata, then the bytes', async () => {
        const { fetch, client } = setup(json(uploaded))
        const file = new Blob(['- water the beans\n'], { type: 'text/plain' })
        await expect(uploadFile(client, file, 'Garden plan.txt')).resolves.toEqual(uploaded)

        const [request] = fetch.requests
        expect(request.method).toBe('POST')
        expect(request.url.origin + request.url.pathname).toBe('https://www.googleapis.com/upload/drive/v3/files')
        expect(Object.fromEntries(request.url.searchParams)).toEqual({ uploadType: 'multipart', fields: 'id,name,mimeType,webViewLink,iconLink' })

        const boundary = /^multipart\/related; boundary=(.+)$/.exec(request.headers['content-type'])?.[1]
        expect(boundary).toBeTruthy()
        expect(await bodyText(request)).toBe(
            `--${boundary}\r\n` +
                'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
                '{"name":"Garden plan.txt","mimeType":"text/plain"}\r\n' +
                `--${boundary}\r\n` +
                'Content-Type: text/plain\r\n\r\n' +
                '- water the beans\n' +
                `\r\n--${boundary}--`,
        )
    })

    it('keeps the bytes of a binary file as they are', async () => {
        const { fetch, client } = setup(json(uploaded))
        const bytes = Uint8Array.from([0, 255, 13, 10, 128, 7])
        await uploadFile(client, new Blob([bytes]), 'Kitchen.bin')
        const body = new Uint8Array(await new Response(fetch.requests[0].body).arrayBuffer())
        const text = new TextDecoder('latin1').decode(body)
        expect(text).toContain('"mimeType":"application/octet-stream"')
        const start = text.indexOf('Content-Type: application/octet-stream\r\n\r\n') + 'Content-Type: application/octet-stream\r\n\r\n'.length
        expect([...body.slice(start, start + bytes.length)]).toEqual([...bytes])
    })

    it('sends a large file in a resumable upload, to the session Google gives', async () => {
        const session = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=garden-session'
        const { fetch, client } = setup(new Response(null, { status: 200, headers: { Location: session } }), json(uploaded))
        const file = new Blob([new Uint8Array(MULTIPART_LIMIT + 1)], { type: 'video/mp4' })
        await expect(uploadFile(client, file, 'Garden tour.mp4')).resolves.toEqual(uploaded)

        const [start, put] = fetch.requests
        expect(start.method).toBe('POST')
        expect(Object.fromEntries(start.url.searchParams)).toEqual({ uploadType: 'resumable', fields: 'id,name,mimeType,webViewLink,iconLink' })
        expect(start.headers).toMatchObject({
            'content-type': 'application/json',
            'x-upload-content-type': 'video/mp4',
            'x-upload-content-length': String(MULTIPART_LIMIT + 1),
        })
        expect(JSON.parse(await bodyText(start))).toEqual({ name: 'Garden tour.mp4', mimeType: 'video/mp4' })

        expect(put.method).toBe('PUT')
        expect(put.url.toString()).toBe(session)
        expect(put.headers['content-type']).toBe('video/mp4')
        expect(put.body).toBe(file)
    })

    it('says plainly when the upload session can’t be read', async () => {
        const { fetch, client } = setup(new Response(null, { status: 200 }))
        const file = new Blob([new Uint8Array(MULTIPART_LIMIT + 1)])
        const error = await uploadFile(client, file, 'Garden tour.mp4').catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(GoogleError)
        expect(error).toMatchObject({ reason: 'uploadSessionHidden', message: expect.stringContaining('too large to attach from here') })
        expect(fetch.requests).toHaveLength(1)
    })
})

describe('fileIdFromDriveLink', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345'

    it.each([
        `https://drive.google.com/file/d/${id}/view?usp=sharing`,
        `https://drive.google.com/file/d/${id}`,
        `https://docs.google.com/document/d/${id}/edit`,
        `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`,
        `https://docs.google.com/presentation/d/${id}/edit?usp=sharing`,
        `https://docs.google.com/forms/d/${id}/viewform`,
        `https://drive.google.com/open?id=${id}`,
        `https://drive.google.com/uc?id=${id}&export=download`,
        `  https://drive.google.com/file/d/${id}/view  `,
    ])('reads the id from %s', (url) => {
        expect(fileIdFromDriveLink(url)).toBe(id)
    })

    it.each([
        'https://example.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view',
        'https://drive.google.com/drive/my-drive',
        'https://docs.google.com/forms/d/e/1FAIpQLSc-garden/viewform',
        'not a link',
        'javascript:alert(1)',
        '',
    ])('gives null for %s', (url) => {
        expect(fileIdFromDriveLink(url)).toBeNull()
    })
})

describe('attachmentFromDriveFile', () => {
    it('attaches by the file’s Drive link, as Google Calendar does', () => {
        expect(attachmentFromDriveFile(uploaded)).toEqual({
            fileUrl: uploaded.webViewLink,
            title: 'Garden plan.txt',
            mimeType: 'text/plain',
            iconLink: uploaded.iconLink,
            fileId: uploaded.id,
        })
    })

    it('leaves out an icon Drive did not give', () => {
        const { iconLink: _, ...withoutIcon } = uploaded
        expect(attachmentFromDriveFile(withoutIcon)).not.toHaveProperty('iconLink')
    })
})
