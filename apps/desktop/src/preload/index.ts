import { contextBridge, ipcRenderer } from 'electron';
import { createDesktopApi } from './api.js';

contextBridge.exposeInMainWorld('agentDesktop', createDesktopApi(ipcRenderer));
