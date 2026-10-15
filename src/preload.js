'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  // arayüz dili (açılışta senkron alınır ki ilk çizim doğru dilde olsun)
  lang: ipcRenderer.sendSync('app:lang'),
  version: ipcRenderer.sendSync('app:version'),

  // Mastertool hesabı ve senkron
  accountState: () => ipcRenderer.invoke('account:state'),
  login: (email, password, remember) => ipcRenderer.invoke('account:login', { email, password, remember }),
  logout: () => ipcRenderer.invoke('account:logout'),
  syncNow: () => ipcRenderer.invoke('account:syncNow'),
  setSyncEnabled: (on) => ipcRenderer.invoke('account:setSync', on),
  deleteRemoteLibrary: () => ipcRenderer.invoke('account:deleteRemote'),
  openWeb: (page) => ipcRenderer.invoke('account:openWeb', page), // 'forgot' | 'register' | 'account'
  onAccountStatus: on('account:status'),
  onUpdateAvailable: on('app:update'),
  onLibraryBackup: on('account:backup'),
  openMastertool: () => ipcRenderer.invoke('app:openMastertool'),
  showMain: () => ipcRenderer.invoke('app:showMain'),

  // depo
  getStore: () => ipcRenderer.invoke('store:get'),
  onStoreChanged: on('store:changed'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // projeler ve klasörler (ana pencere)
  saveProject: (form) => ipcRenderer.invoke('project:save', form),
  deleteProject: (id) => ipcRenderer.invoke('project:delete', id),
  duplicateProject: (id) => ipcRenderer.invoke('project:duplicate', id),
  moveProject: (id, folderId) => ipcRenderer.invoke('project:move', { id, folderId }),
  openProject: (id) => ipcRenderer.invoke('project:open', id),
  clearProjectOutputs: (id, transcripts) => ipcRenderer.invoke('project:clearOutputs', { id, transcripts }),
  projectStats: () => ipcRenderer.invoke('projects:stats'),
  onProjectStats: on('projects:stats'),
  saveFolder: (f) => ipcRenderer.invoke('folder:save', f),
  moveFolder: (id, parentId) => ipcRenderer.invoke('folder:move', { id, parentId }),
  deleteFolder: (id) => ipcRenderer.invoke('folder:delete', id),
  pickSource: (opts) => ipcRenderer.invoke('dialog:pickSource', opts),

  // proje penceresi
  pjInit: () => ipcRenderer.invoke('pj:init'),
  pjScan: () => ipcRenderer.invoke('pj:scan'),
  pjCheck: (rels, checked) => ipcRenderer.invoke('pj:check', { rels, checked }),
  pjStart: (opts) => ipcRenderer.invoke('pj:start', opts),
  pjStop: () => ipcRenderer.invoke('pj:stop'),
  pjTranscribe: (rels) => ipcRenderer.invoke('pj:transcribe', rels),
  pjTranscript: (rel) => ipcRenderer.invoke('pj:transcript', rel),
  pjExportTranscript: (rel, format) => ipcRenderer.invoke('pj:exportTranscript', { rel, format }),
  pjDeleteOutputs: (opts) => ipcRenderer.invoke('pj:deleteOutputs', opts),
  pjSetConcurrency: (n) => ipcRenderer.invoke('pj:setConcurrency', n),
  pjChangeSource: () => ipcRenderer.invoke('pj:changeSource'),
  pjPreview: (rel, which) => ipcRenderer.invoke('pj:preview', { rel, which }),
  pjProxy: (rel, which) => ipcRenderer.invoke('pj:proxy', { rel, which }),
  pjOpen: (rel, which) => ipcRenderer.invoke('pj:open', { rel, which }),
  pjReveal: (rel, which) => ipcRenderer.invoke('pj:reveal', { rel, which }),
  pjOpenOutDir: () => ipcRenderer.invoke('pj:openOutDir'),
  pjExportOutputs: (rels) => ipcRenderer.invoke('pj:exportOutputs', rels),
  pjOutSize: () => ipcRenderer.invoke('pj:outSize'),
  onJobItems: on('job:items'),
  onJobState: on('job:state'),
  onJobFinished: on('job:finished'),
  onProjectChanged: on('project:changed'),
  onPreviewProgress: on('preview:progress'),

  // konuşma motoru ve depolama
  speechStatus: () => ipcRenderer.invoke('speech:status'),
  speechDownload: (model) => ipcRenderer.invoke('speech:download', model),
  speechCancelDownload: (model) => ipcRenderer.invoke('speech:cancelDownload', model),
  speechDeleteModel: (model) => ipcRenderer.invoke('speech:deleteModel', model),
  onSpeechDownload: on('speech:download'),
  storageInfo: () => ipcRenderer.invoke('storage:info'),
  clearConverted: (transcripts) => ipcRenderer.invoke('storage:clearConverted', { transcripts }),
  clearCache: () => ipcRenderer.invoke('storage:clearCache'),
  openStorage: (which) => ipcRenderer.invoke('storage:open', which),
});
