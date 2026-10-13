/**
 * Putting a file in the person's Google Drive to attach to an event, and reading Drive links.
 *
 * With the `drive.file` scope the extension sees only the files it created, so an upload is the
 * one way it adds a file of the person's to an event. A file already in Drive is attached by its
 * link instead (`fileIdFromDriveLink`), which needs no Drive access at all.
 */
import { GoogleError, type GoogleClient } from './http'
import type { DriveFile, EventAttachment } from './types'

const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'

/** The fields an upload's answer carries: what `attachmentFromDriveFile` needs. */
const FILE_FIELDS = 'id,name,mimeType,webViewLink,iconLink'

/** The largest file Drive takes in one multipart request. A larger one goes up in a resumable upload. */
export const MULTIPART_LIMIT = 5 * 1024 * 1024

/** Upload a file to the root of the person's Drive. */
export async function uploadFile(client: GoogleClient, file: Blob, name: string, options: { signal?: AbortSignal } = {}): Promise<DriveFile> {
    const mimeType = file.type || 'application/octet-stream'
    const metadata = { name, mimeType }
    return file.size <= MULTIPART_LIMIT ? uploadMultipart(client, file, metadata, options.signal) : uploadResumable(client, file, metadata, options.signal)
}

/**
 * One request in two parts, as `multipart/related`: the file's metadata as JSON, then its bytes.
 * The body is a `Blob` of the parts, so the file's bytes are never copied into a string.
 */
async function uploadMultipart(client: GoogleClient, file: Blob, metadata: { name: string; mimeType: string }, signal?: AbortSignal): Promise<DriveFile> {
    const boundary = `etherpk-${crypto.randomUUID()}`
    const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
        `--${boundary}\r\nContent-Type: ${metadata.mimeType}\r\n\r\n`,
        file,
        `\r\n--${boundary}--`,
    ])
    return client.request<DriveFile>(UPLOAD_URL, {
        method: 'POST',
        query: { uploadType: 'multipart', fields: FILE_FIELDS },
        body,
        contentType: `multipart/related; boundary=${boundary}`,
        signal,
    })
}

/**
 * Two requests: the first sends the metadata and Google answers with an upload session's address in
 * its `Location` header, and the second sends the bytes there.
 *
 * A browser hides a response header from the page unless the server lists it as exposed (CORS).
 * Google's upload server does expose `Location` (Google's own browser sample, cors-upload-sample,
 * reads it), but if it ever stops, the upload can't go on, and the person is told plainly.
 */
async function uploadResumable(client: GoogleClient, file: Blob, metadata: { name: string; mimeType: string }, signal?: AbortSignal): Promise<DriveFile> {
    const started = await client.request<Response>(UPLOAD_URL, {
        method: 'POST',
        query: { uploadType: 'resumable', fields: FILE_FIELDS },
        json: metadata,
        headers: { 'X-Upload-Content-Type': metadata.mimeType, 'X-Upload-Content-Length': String(file.size) },
        responseType: 'response',
        signal,
    })
    const session = started.headers.get('Location')
    if (!session) {
        throw new GoogleError('This file is too large to attach from here. Add it to Google Drive yourself, then attach it by its link.', {
            status: started.status,
            kind: 'bad-request',
            reason: 'uploadSessionHidden',
        })
    }
    return client.request<DriveFile>(session, { method: 'PUT', body: file, contentType: metadata.mimeType, signal })
}

/** Drive file ids are long, so a short path segment such as the `e` in a published form's link isn't taken for one. */
const ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/

/**
 * The Drive file id in a link to a file, or null. Takes `drive.google.com/file/d/<id>/…`, Google
 * Docs, Sheets, Slides and Forms links (`docs.google.com/<kind>/d/<id>/…`), and the older
 * `?id=<id>` links (`drive.google.com/open?id=<id>`).
 */
export function fileIdFromDriveLink(url: string): string | null {
    let parsed: URL
    try {
        parsed = new URL(url.trim())
    } catch {
        return null
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    if (parsed.hostname !== 'drive.google.com' && parsed.hostname !== 'docs.google.com') return null
    const segments = parsed.pathname.split('/')
    const marker = segments.indexOf('d')
    const fromPath = marker >= 0 ? segments[marker + 1] : undefined
    if (fromPath && ID_PATTERN.test(fromPath)) return fromPath
    const fromQuery = parsed.searchParams.get('id')
    if (fromQuery && ID_PATTERN.test(fromQuery)) return fromQuery
    return null
}

/** An event attachment for a Drive file, in the form Google Calendar's own attachments take. */
export function attachmentFromDriveFile(file: DriveFile): EventAttachment {
    return {
        fileUrl: file.webViewLink,
        title: file.name,
        mimeType: file.mimeType,
        fileId: file.id,
        ...(file.iconLink ? { iconLink: file.iconLink } : {}),
    }
}
