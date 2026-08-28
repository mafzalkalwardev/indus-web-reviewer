const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("indusDesktop", {
  isElectron: true,
  apiBase: "http://127.0.0.1:3847",
});
