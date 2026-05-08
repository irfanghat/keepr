# Keepr

Keepr is a secure, browser-based vault for storing files and text using strong client-side encryption. All data is encrypted locally in the browser, meaning only you can access it using your master key. No data is ever sent to a server.

## Features

* Client-side AES-256-GCM encryption
* Master key authentication (never stored or transmitted)
* Local storage using IndexedDB
* Store and manage files and text snippets
* Built-in preview for encrypted content
* Basic usage analytics dashboard
* Option to permanently wipe all stored data

## Security

* Encryption: AES-256-GCM
* Key derivation: PBKDF2 (SHA-256, 100,000 iterations)
* All encryption and decryption happens locally in the browser
* Losing your master key results in permanent data loss

## How It Works

1. Enter your master key to unlock the vault
2. Upload files or paste text content
3. Data is encrypted in the browser before being stored
4. Everything is saved locally in IndexedDB
5. Only the correct master key can decrypt stored data

## Tech Stack

* Vue 3
* Web Crypto API
* IndexedDB
* HTML / CSS / JavaScript
* Ionicons

## Warning

This application is fully client-side. If you lose your master key, your data cannot be recovered under any circumstances.

## License

MIT License

If you want, I can also tighten it further into a “one-screen GitHub landing README” or make it sound more enterprise-grade.
