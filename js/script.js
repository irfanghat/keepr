const { createApp } = Vue;
const DB_NAME = "keepr_db";

/* Session timeout constants  */

// -------------------------------------
// 30 minutes of inactivity
// -------------------------------------
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// -------------------------------------
// Seconds to act before auto-lock
// -------------------------------------
const WARNING_DURATION_S = 60;
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];

createApp({
    data() {
        return {
            /*  Authentication  */
            unlocked: false,
            password: '',
            isUnlocking: false,
            cryptoKey: null,

            /*  Vault State  */
            items: [],
            view: 'drive',
            db: null,

            /*  Preview Panel  */
            selected: null,
            previewOpen: false,
            previewContent: '',
            previewError: null,

            /*  Toast Queue  */
            toasts: [],

            /* Inline name editing */
            editingId: null,   // id of the item currently being renamed
            editingName: '',     // current value of the rename input

            /* Session timeout */
            showTimeoutWarning: false,
            timeoutCountdown: WARNING_DURATION_S,
        };
    },

    computed: {
        totalSize() {
            return this.items
                .reduce((acc, item) => acc + parseFloat(item.size), 0)
                .toFixed(1);
        },

        /** SVG stroke-dasharray for the countdown ring (circumference = 2π × 30 ≈ 188.5) */
        countdownDash() {
            const circumference = 2 * Math.PI * 30; // r = 30
            const filled = (this.timeoutCountdown / WARNING_DURATION_S) * circumference;
            return `${filled.toFixed(2)} ${circumference.toFixed(2)}`;
        },
    },

    /**  Bootstrap IndexedDB  */
    async mounted() {
        try {
            this.db = await new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, 1);
                req.onupgradeneeded = e => {
                    e.target.result.createObjectStore('secrets', { keyPath: 'id', autoIncrement: true });
                    e.target.result.createObjectStore('meta');
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        } catch (err) {
            this.showToast(
                'error',
                'Database Unavailable',
                'Could not open the local IndexedDB store.',
                'Check your browser storage permissions, or try a different browser.'
            );
        }
    },

    methods: {

        /********************************************
           TOAST SYSTEM
        ********************************************/
        showToast(type, context, message, action = null) {
            const id = Date.now() + Math.random();
            this.toasts.push({ id, type, context, message, action });
            setTimeout(() => this.dismissToast(id), 4500);
        },

        dismissToast(id) {
            this.toasts = this.toasts.filter(t => t.id !== id);
        },


        /********************************************
           SESSION TIMEOUT
        ********************************************/

        /**
         * Start activity tracking and arm the 30-minute inactivity timer.
         * Called once after a successful unlock.
         */
        initSessionTimeout() {
            // -----------------------------------------------------------
            // Store the handler reference so we can remove it later
            // -----------------------------------------------------------
            this._activityHandler = () => {
                if (!this.showTimeoutWarning) {
                    this.resetSessionTimer();
                }
            };

            ACTIVITY_EVENTS.forEach(ev =>
                document.addEventListener(ev, this._activityHandler, { passive: true })
            );

            this.resetSessionTimer();
        },

        /** Arm (or re-arm) the 30-minute countdown. */
        resetSessionTimer() {
            clearTimeout(this._sessionTimer);
            this._sessionTimer = setTimeout(
                () => this.triggerTimeoutWarning(),
                SESSION_TIMEOUT_MS
            );
        },

        /** Show the warning modal and start the 60-second countdown. */
        triggerTimeoutWarning() {
            this.showTimeoutWarning = true;
            this.timeoutCountdown = WARNING_DURATION_S;

            this._warningInterval = setInterval(() => {
                this.timeoutCountdown -= 1;
                if (this.timeoutCountdown <= 0) {
                    clearInterval(this._warningInterval);
                    this.lock();
                }
            }, 1000);
        },

        /** User clicked "Keep Session Active" – dismiss modal and reset timer. */
        keepSessionActive() {
            this.showTimeoutWarning = false;
            clearInterval(this._warningInterval);
            this.resetSessionTimer();
            this.showToast('success', 'Session Extended', 'Your vault session has been refreshed.');
        },

        /** Tear down all timers and event listeners (called before lock). */
        cleanupSessionTimeout() {
            clearTimeout(this._sessionTimer);
            clearInterval(this._warningInterval);
            if (this._activityHandler) {
                ACTIVITY_EVENTS.forEach(ev =>
                    document.removeEventListener(ev, this._activityHandler)
                );
            }
        },


        /********************************************
           INLINE ENTRY-NAME EDITING
        ********************************************/

        /**
         * Enter edit mode for a table row.
         * The event is stopped so it doesn't also trigger openPreview.
         */
        startEdit(item) {
            this.editingId = item.id;
            this.editingName = item.name;

            this.$nextTick(() => {
                const input = document.getElementById(`edit-input-${item.id}`);
                if (input) { input.focus(); input.select(); }
            });
        },

        /** Commit the rename (called on Enter or blur). */
        saveEdit() {
            // --------------------------------------------------------------------
            // _editCancelled is set by cancelEdit() to prevent blur from saving
            // --------------------------------------------------------------------
            if (this._editCancelled) {
                this._editCancelled = false;
                return;
            }
            if (!this.editingId) return;

            const trimmed = this.editingName.trim();
            const id = this.editingId;

            this.editingId = null;
            this.editingName = '';

            // ------------------------
            // Ignore empty names
            // ------------------------
            if (!trimmed) return;

            const original = this.items.find(i => i.id === id)?.name;
            // -----------------------------
            // No change
            // -----------------------------
            if (trimmed === original) return;

            this.updateItemName(id, trimmed);
        },

        /** Discard the rename without saving (Escape key). */
        cancelEdit() {
            this._editCancelled = true;
            this.editingId = null;
            this.editingName = '';

            // ------------------------------------------------
            // Clear the flag after the blur event has fired
            // ------------------------------------------------
            setTimeout(() => { this._editCancelled = false; }, 50);
        },

        /** Persist the new name to IndexedDB and refresh the item list. */
        async updateItemName(id, newName) {
            const item = this.items.find(i => i.id === id);
            if (!item) return;

            try {
                const updated = { ...item, name: newName };

                await new Promise((resolve, reject) => {
                    const tx = this.db.transaction('secrets', 'readwrite');
                    tx.objectStore('secrets').put(updated);
                    tx.oncomplete = resolve;
                    tx.onerror = () => reject(tx.error);
                });

                // ------------------------------------------------
                // Reload and re-sync the selected reference
                // ------------------------------------------------
                const freshItems = await new Promise((resolve, reject) => {
                    const tx = this.db.transaction('secrets', 'readonly');
                    const req = tx.objectStore('secrets').getAll();
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });

                this.items = freshItems;

                if (this.selected && this.selected.id === id) {
                    this.selected = this.items.find(i => i.id === id) || null;
                }

                this.showToast('success', 'Entry Renamed', `Saved as "${newName}".`);
            } catch (err) {
                this.showToast(
                    'error',
                    'Rename Failed',
                    'Could not update the entry name in the database.',
                    'Refresh the page and try again.'
                );
            }
        },


        /********************************************
           VAULT OPERATIONS
        ********************************************/

        /** Derive CryptoKey from master password via PBKDF2, then unlock. */
        async unlock() {
            if (!this.password || this.isUnlocking) return;
            this.isUnlocking = true;
            try {
                const tx = this.db.transaction('meta', 'readwrite');
                let salt = await new Promise(r => {
                    const g = tx.objectStore('meta').get('salt');
                    g.onsuccess = () => r(g.result);
                });
                if (!salt) {
                    salt = crypto.getRandomValues(new Uint8Array(16));
                    tx.objectStore('meta').put(salt, 'salt');
                }
                const keyMat = await crypto.subtle.importKey(
                    'raw', new TextEncoder().encode(this.password),
                    'PBKDF2', false, ['deriveKey']
                );
                this.cryptoKey = await crypto.subtle.deriveKey(
                    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
                    keyMat,
                    { name: 'AES-GCM', length: 256 },
                    false,
                    ['encrypt', 'decrypt']
                );
                this.unlocked = true;
                await this.load();
                this.showToast('success', 'Vault Unlocked', 'Secure session active. Key is held in memory only.');

                // Arm the inactivity timer after the vault is open
                this.$nextTick(() => this.initSessionTimeout());
            } catch (err) {
                this.showToast(
                    'error',
                    'Key Derivation Failed',
                    'The cryptographic key could not be initialised.',
                    'Ensure your browser supports WebCrypto and that no extensions are blocking it.'
                );
            } finally {
                this.isUnlocking = false;
            }
        },

        /** Read all records from IndexedDB. */
        async load() {
            try {
                const tx = this.db.transaction('secrets', 'readonly');
                tx.objectStore('secrets').getAll().onsuccess = e => {
                    this.items = e.target.result;
                };
            } catch (err) {
                this.showToast(
                    'error',
                    'Load Failed',
                    'Could not read assets from the vault database.',
                    'Refresh the page and re-enter your master key.'
                );
            }
        },

        /** Decrypt and display a vault entry in the preview panel. */
        async openPreview(item) {
            this.selected = item;
            this.previewOpen = true;
            this.previewError = null;
            this.previewContent = '';

            if (item.isText) {
                try {
                    const dec = await crypto.subtle.decrypt(
                        { name: 'AES-GCM', iv: item.iv },
                        this.cryptoKey,
                        item.payload
                    );
                    this.previewContent = new TextDecoder().decode(dec);
                } catch (err) {
                    this.previewError = {
                        context: 'Decryption Failed',
                        message: 'This asset could not be decrypted. The session key may be invalid, or the stored payload has been corrupted.',
                        action: 'Lock the vault and re-open it using the correct master key.',
                    };
                }
            }
        },

        /** Encrypt a buffer and persist it to IndexedDB. */
        async save(buf, name, type, isText) {
            try {
                const iv = crypto.getRandomValues(new Uint8Array(12));
                const payload = await crypto.subtle.encrypt(
                    { name: 'AES-GCM', iv },
                    this.cryptoKey,
                    buf
                );
                const tx = this.db.transaction('secrets', 'readwrite');
                tx.objectStore('secrets').add({
                    name, type, iv, payload, isText,
                    timestamp: Date.now(),
                    size: (buf.byteLength / 1024).toFixed(1),
                });
                await this.load();
                this.showToast('success', 'Entry Saved', `"${name}" encrypted and stored.`);
            } catch (err) {
                this.showToast(
                    'error',
                    'Encryption Failed',
                    `Could not encrypt "${name}".`,
                    'Ensure your vault session is still active and retry.'
                );
            }
        },

        /** Remove a record from IndexedDB. */
        async deleteItem(id) {
            try {
                const tx = this.db.transaction('secrets', 'readwrite');
                tx.objectStore('secrets').delete(id);
                this.previewOpen = false;
                this.selected = null;
                await this.load();
                this.showToast('info', 'Entry Deleted', 'The encrypted asset was removed from the vault.');
            } catch (err) {
                this.showToast(
                    'error',
                    'Delete Failed',
                    'Could not remove the entry from IndexedDB.',
                    'Refresh the page and try again.'
                );
            }
        },

        /** Handle clipboard paste, saves as text entry. */
        async handlePaste(e) {
            const txt = e.clipboardData.getData('text');
            if (txt) {
                await this.save(
                    new TextEncoder().encode(txt),
                    `Paste_${new Date().toLocaleTimeString()}`,
                    'text/plain',
                    true
                );
            }
        },

        /** Handle file upload, saves as binary entry. */
        async handleFile(e) {
            const f = e.target.files[0];
            if (!f) return;
            try {
                const buf = await f.arrayBuffer();
                await this.save(buf, f.name, f.type, false);
            } catch (err) {
                this.showToast(
                    'error',
                    'Upload Failed',
                    `Could not read "${f?.name}".`,
                    'Check the file is accessible and not corrupted, then try again.'
                );
            }
            e.target.value = '';
        },

        /** Decrypt binary entry and trigger browser download. */
        download() {
            crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: this.selected.iv },
                this.cryptoKey,
                this.selected.payload
            )
                .then(dec => {
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(new Blob([dec], { type: this.selected.type }));
                    a.download = this.selected.name;
                    a.click();
                    this.showToast('success', 'File Decrypted', `"${this.selected.name}" has been downloaded.`);
                })
                .catch(() => {
                    this.showToast(
                        'error',
                        'Download Failed',
                        'Decryption error, cannot restore the original file.',
                        'Verify your master key and that your session has not expired.'
                    );
                });
        },

        /** Copy decrypted text to clipboard. */
        copy() {
            navigator.clipboard.writeText(this.previewContent)
                .then(() => {
                    this.showToast('success', 'Copied', 'Decrypted content copied to clipboard.');
                })
                .catch(() => {
                    this.showToast(
                        'error',
                        'Clipboard Denied',
                        'Browser blocked clipboard access.',
                        'Grant clipboard permissions in your browser settings and try again.'
                    );
                });
        },

        /** Irreversibly delete the IndexedDB database. */
        purgeVault() {
            if (confirm('Permanently wipe ALL vault data? This cannot be undone.')) {
                this.cleanupSessionTimeout();
                indexedDB.deleteDatabase(DB_NAME);
                location.reload();
            }
        },

        /** Clear session — reload wipes the in-memory key. */
        lock() {
            this.cleanupSessionTimeout();
            location.reload();
        },
    }

}).mount('#app');