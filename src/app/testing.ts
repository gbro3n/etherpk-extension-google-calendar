/**
 * Stand-ins for the parts of the Extension API the extension's own modules use, for their tests:
 * a person's records over a map, and storage on one device.
 */
import type { ExtensionPersonStorage, ExtensionStorage } from '@appsoftwareltd/etherpk-extension-api'

export function memoryPersonStorage(): ExtensionPersonStorage & { raw: Map<string, string> } {
    const raw = new Map<string, string>()
    const listeners = new Set<() => void>()
    const changed = () => listeners.forEach((listener) => listener())
    return {
        raw,
        get: <T,>(key: string) => (raw.has(key) ? (JSON.parse(raw.get(key)!) as T) : undefined),
        set(key, value) {
            if (value === undefined || value === null) raw.delete(key)
            else raw.set(key, JSON.stringify(value))
            changed()
        },
        remove(key) {
            raw.delete(key)
            changed()
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => void listeners.delete(listener)
        },
    }
}

export function memoryStorage(): ExtensionStorage {
    const raw = new Map<string, string>()
    return {
        get: <T,>(key: string) => (raw.has(key) ? (JSON.parse(raw.get(key)!) as T) : undefined),
        set: (key, value) => void raw.set(key, JSON.stringify(value)),
        remove: (key) => void raw.delete(key),
    }
}
