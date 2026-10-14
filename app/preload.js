// The wire between the see-through window and the page in it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coach', {
  hit: (over) => ipcRenderer.send('hit', over),
  ask: (text) => ipcRenderer.invoke('ask', text),
  quit: () => ipcRenderer.send('quit'),
  drawn: (id) => ipcRenderer.send('drawn', id),                        // every mark of answer `id` is on the screen
  onAnswer: (fn) => ipcRenderer.on('answer', (_e, a) => fn(a)),
  onStage: (fn) => ipcRenderer.on('stage', (_e, s) => fn(s)),          // a true stage of the wait: { id, what }
  onSlot: (fn) => ipcRenderer.on('slot', (_e, s) => fn(s)),            // which chat holds the coach, and its light
  onTest: (fn) => ipcRenderer.on('test', (_e, t) => fn(t)),            // only the unseen test (--cotest) sends this
});
