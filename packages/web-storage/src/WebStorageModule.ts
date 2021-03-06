import { BNString, IModule, ITKeyApi, prettyPrintError, ShareStore } from "@tkey/common-types";
import BN from "bn.js";

import { canAccessFileStorage, getShareFromFileStorage, storeShareOnFileStorage } from "./FileStorageHelpers";
import { getShareFromLocalStorage, storeShareOnLocalStorage } from "./LocalStorageHelpers";

export const WEB_STORAGE_MODULE_NAME = "webStorage";

class WebStorageModule implements IModule {
  moduleName: string;

  tbSDK: ITKeyApi;

  canUseFileStorage: boolean;

  constructor(canUseFileStorage = true) {
    this.moduleName = WEB_STORAGE_MODULE_NAME;
    this.canUseFileStorage = canUseFileStorage;
    this.setFileStorageAccess();
  }

  async setFileStorageAccess(): Promise<void> {
    try {
      const result = await canAccessFileStorage();
      if (result.state === "denied") {
        this.canUseFileStorage = false;
      } else if (result.state === "granted") {
        this.canUseFileStorage = true;
      }
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      result.onchange = function permissionChange() {
        if (this.state === "denied") {
          self.canUseFileStorage = false;
        } else if (this.state === "granted") {
          self.canUseFileStorage = true;
        }
      };
      // eslint-disable-next-line no-empty
    } catch (error) {}
  }

  setModuleReferences(tbSDK: ITKeyApi): void {
    this.tbSDK = tbSDK;
    this.tbSDK.setDeviceStorage(this.storeDeviceShare.bind(this));
  }

  // eslint-disable-next-line
  async initialize(): Promise<void> {}

  async storeDeviceShare(deviceShareStore: ShareStore): Promise<void> {
    const metadata = this.tbSDK.getMetadata();
    const tkeypubx = metadata.pubKey.x.toString("hex");
    await storeShareOnLocalStorage(deviceShareStore, tkeypubx);
    await this.tbSDK.addShareDescription(
      deviceShareStore.share.shareIndex.toString("hex"),
      JSON.stringify({ module: this.moduleName, userAgent: window.navigator.userAgent, dateAdded: Date.now() }),
      true
    );
  }

  async storeDeviceShareOnFileStorage(shareIndex: BNString): Promise<void> {
    const metadata = this.tbSDK.getMetadata();
    const tkeypubx = metadata.pubKey.x.toString("hex");
    const shareStore = this.tbSDK.outputShareStore(new BN(shareIndex));
    return storeShareOnFileStorage(shareStore, tkeypubx);
  }

  async getDeviceShare(): Promise<ShareStore> {
    const metadata = this.tbSDK.getMetadata();
    const tkeypubx = metadata.pubKey.x.toString("hex");
    let shareStore: ShareStore;
    try {
      shareStore = await getShareFromLocalStorage(tkeypubx);
    } catch (localErr) {
      if (this.canUseFileStorage) {
        try {
          shareStore = await getShareFromFileStorage(tkeypubx);
        } catch (fileErr) {
          if (fileErr?.message?.includes("storage quota")) {
            // User has denied access to storage. stop asking for every share
            this.canUseFileStorage = false;
          }
          throw new Error(`Error inputShareFromWebStorage: ${prettyPrintError(localErr)} and ${prettyPrintError(fileErr)}`);
        }
      }
      throw new Error(`Error inputShareFromWebStorage: ${prettyPrintError(localErr)}`);
    }
    return shareStore;
  }

  async inputShareFromWebStorage(): Promise<void> {
    const shareStore = await this.getDeviceShare();
    const latestShareDetails = await this.tbSDK.catchupToLatestShare(shareStore);
    const metadata = this.tbSDK.getMetadata();
    const tkeypubx = metadata.pubKey.x.toString("hex");
    await storeShareOnLocalStorage(latestShareDetails.latestShare, tkeypubx);
    this.tbSDK.inputShareStore(latestShareDetails.latestShare);
  }
}

export default WebStorageModule;
