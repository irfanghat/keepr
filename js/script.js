const { createApp } = Vue;
const DB_NAME = "keepr_db";

createApp({
    data() {
        return {
            unlocked: false, password: '', cryptoKey: null,
            items: [], view: 'drive', db: null,
            selected: null, previewOpen: false, previewContent: ''
        }
    },
    computed: {
        totalSize() {
            return this.items.reduce((acc, item) => acc + parseFloat(item.size), 0).toFixed(1);
        }
    },
    async mounted() {
        this.db = await new Promise(r => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = e => {
                e.target.result.createObjectStore('secrets', { keyPath: "id", autoIncrement: true });
                e.target.result.createObjectStore('meta');
            };
            req.onsuccess = () => r(req.result);
        });
    },
    methods: {
        async unlock() {
            if (!this.password) return;
            const tx = this.db.transaction('meta', 'readwrite');
            let salt = await new Promise(r => {
                const g = tx.objectStore('meta').get('salt');
                g.onsuccess = () => r(g.result);
            });
            if (!salt) {
                salt = crypto.getRandomValues(new Uint8Array(16));
                tx.objectStore('meta').put(salt, 'salt');
            }
            const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode(this.password), 'PBKDF2', false, ['deriveKey']);
            this.cryptoKey = await crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
                keyMat, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
            );
            this.unlocked = true;
            this.load();
        },
        async load() {
            const tx = this.db.transaction('secrets', 'readonly');
            tx.objectStore('secrets').getAll().onsuccess = (e) => { this.items = e.target.result; };
        },
        async openPreview(item) {
            this.selected = item;
            this.previewOpen = true;
            if (item.isText) {
                try {
                    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: item.iv }, this.cryptoKey, item.payload);
                    this.previewContent = new TextDecoder().decode(dec);
                } catch (e) { this.previewContent = "Error: Key incorrect or data corrupted."; }
            }
        },
        async save(buf, name, type, isText) {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const payload = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.cryptoKey, buf);
            const tx = this.db.transaction('secrets', 'readwrite');
            tx.objectStore('secrets').add({ name, type, iv, payload, isText, timestamp: Date.now(), size: (buf.byteLength / 1024).toFixed(1) });
            this.load();
        },
        async deleteItem(id) {
            const tx = this.db.transaction('secrets', 'readwrite');
            tx.objectStore('secrets').delete(id);
            this.previewOpen = false;
            this.load();
        },
        async handlePaste(e) {
            const txt = e.clipboardData.getData('text');
            if (txt) await this.save(new TextEncoder().encode(txt), `Paste_${new Date().toLocaleTimeString()}`, 'text/plain', true);
        },
        async handleFile(e) {
            const f = e.target.files[0];
            if (f) await this.save(await f.arrayBuffer(), f.name, f.type, false);
        },
        download() {
            crypto.subtle.decrypt({ name: 'AES-GCM', iv: this.selected.iv }, this.cryptoKey, this.selected.payload).then(dec => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([dec], { type: this.selected.type }));
                a.download = this.selected.name; a.click();
            });
        },
        copy() { navigator.clipboard.writeText(this.previewContent); },
        purgeVault() { if (confirm("Permanently wipe all data?")) { indexedDB.deleteDatabase(DB_NAME); location.reload(); } },
        lock() { location.reload(); }
    }
}).mount('#app');