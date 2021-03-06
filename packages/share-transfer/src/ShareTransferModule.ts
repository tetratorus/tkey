import {
  decrypt,
  encrypt,
  getPubKeyECC,
  getPubKeyPoint,
  IModule,
  ITKeyApi,
  ShareStore,
  ShareTransferStorePointerArgs,
  toPrivKeyECC,
} from "@tkey/common-types";
import { generatePrivate } from "@toruslabs/eccrypto";
import BN from "bn.js";

import ShareRequest from "./ShareRequest";
import ShareTransferStorePointer from "./ShareTransferStorePointer";

// @flow
export type ShareTransferStore = {
  [encPubKeyX: string]: ShareRequest;
};

export const SHARE_TRANSFER_MODULE_NAME = "shareTransfer";

class ShareTransferModule implements IModule {
  moduleName: string;

  tbSDK: ITKeyApi;

  currentEncKey: BN;

  requestStatusCheckId: number;

  requestStatusCheckInterval: number;

  constructor() {
    this.moduleName = SHARE_TRANSFER_MODULE_NAME;
    this.requestStatusCheckInterval = 1000;
  }

  setModuleReferences(tbSDK: ITKeyApi): void {
    this.tbSDK = tbSDK;
  }

  setRequestStatusCheckInterval(interval: number): void {
    this.requestStatusCheckInterval = interval;
  }

  async initialize(): Promise<void> {
    const metadata = this.tbSDK.getMetadata();
    const rawShareTransferStorePointer = metadata.getGeneralStoreDomain(this.moduleName) as ShareTransferStorePointerArgs;
    let shareTransferStorePointer: ShareTransferStorePointer;
    if (!rawShareTransferStorePointer) {
      shareTransferStorePointer = { pointer: new BN(generatePrivate()) };
      metadata.setGeneralStoreDomain(this.moduleName, shareTransferStorePointer);
      await this.tbSDK.syncShareMetadata(); // Requires threshold shares
    } else {
      shareTransferStorePointer = new ShareTransferStorePointer(rawShareTransferStorePointer);
    }
  }

  async requestNewShare(
    userAgent: string,
    availableShareIndexes: Array<string>,
    callback?: (err?: Error, shareStore?: ShareStore) => void
  ): Promise<string> {
    if (this.currentEncKey) throw new Error(`Current request already exists ${this.currentEncKey.toString("hex")}`);
    this.currentEncKey = new BN(generatePrivate());
    const newShareTransferStore = await this.getShareTransferStore();
    const encPubKeyX = getPubKeyPoint(this.currentEncKey).x.toString("hex");
    newShareTransferStore[encPubKeyX] = new ShareRequest({
      encPubKey: getPubKeyECC(this.currentEncKey),
      encShareInTransit: undefined,
      availableShareIndexes,
      userAgent,
      timestamp: Date.now(),
    });
    await this.setShareTransferStore(newShareTransferStore);
    // watcher
    if (callback) {
      this.requestStatusCheckId = Number(
        setInterval(async () => {
          try {
            const latestShareTransferStore = await this.getShareTransferStore();
            if (!this.currentEncKey) throw new Error("Missing current enc key");
            if (latestShareTransferStore[encPubKeyX].encShareInTransit) {
              const shareStoreBuf = await decrypt(toPrivKeyECC(this.currentEncKey), latestShareTransferStore[encPubKeyX].encShareInTransit);
              const receivedShare = ShareStore.fromJSON(JSON.parse(shareStoreBuf.toString()));
              await this.tbSDK.inputShareStoreSafe(receivedShare);
              this._cleanUpCurrentRequest();
              callback(null, receivedShare);
            } else if (!latestShareTransferStore[encPubKeyX]) {
              this._cleanUpCurrentRequest();
              callback(new Error("User cancelled request"));
            }
          } catch (error) {
            this._cleanUpCurrentRequest();
            callback(error);
          }
        }, this.requestStatusCheckInterval)
      );
    }
    return encPubKeyX;
  }

  private _cleanUpCurrentRequest(): void {
    this.currentEncKey = undefined;
    clearInterval(this.requestStatusCheckId);
  }

  async lookForRequests(): Promise<Array<string>> {
    const shareTransferStore = await this.getShareTransferStore();
    return Object.keys(shareTransferStore);
  }

  async approveRequest(encPubKeyX: string, shareStore?: ShareStore): Promise<void> {
    const shareTransferStore = await this.getShareTransferStore();
    let bufferedShare: Buffer;
    if (shareStore) {
      bufferedShare = Buffer.from(JSON.stringify(shareStore));
    } else {
      const store = new ShareRequest(shareTransferStore[encPubKeyX]);
      const { availableShareIndexes } = store;
      const metadata = this.tbSDK.getMetadata();
      const latestPolynomial = metadata.getLatestPublicPolynomial();
      const latestPolynomialId = latestPolynomial.getPolynomialID();
      const indexes = metadata.getShareIndexesForPolynomial(latestPolynomialId);
      const filtered = indexes.filter((el) => !availableShareIndexes.includes(el));
      const share = this.tbSDK.outputShareStore(filtered[0]);
      bufferedShare = Buffer.from(JSON.stringify(share));
    }
    const shareRequest = new ShareRequest(shareTransferStore[encPubKeyX]);
    shareTransferStore[encPubKeyX].encShareInTransit = await encrypt(shareRequest.encPubKey, bufferedShare);
    await this.setShareTransferStore(shareTransferStore);
    this.currentEncKey = undefined;
  }

  async approveRequestWithShareIndex(encPubKeyX: string, shareIndex: string): Promise<void> {
    const deviceShare = this.tbSDK.outputShareStore(shareIndex);
    return this.approveRequest(encPubKeyX, deviceShare);
  }

  async getShareTransferStore(): Promise<ShareTransferStore> {
    const metadata = this.tbSDK.getMetadata();
    const shareTransferStorePointer = new ShareTransferStorePointer(metadata.getGeneralStoreDomain(this.moduleName) as ShareTransferStorePointerArgs);
    return this.tbSDK.storageLayer.getMetadata<ShareTransferStore>({ privKey: shareTransferStorePointer.pointer });
  }

  async setShareTransferStore(shareTransferStore: ShareTransferStore): Promise<void> {
    const metadata = this.tbSDK.getMetadata();
    const shareTransferStorePointer = new ShareTransferStorePointer(metadata.getGeneralStoreDomain(this.moduleName) as ShareTransferStorePointerArgs);
    await this.tbSDK.storageLayer.setMetadata({ input: shareTransferStore, privKey: shareTransferStorePointer.pointer });
  }

  async startRequestStatusCheck(encPubKeyX: string, deleteRequestAfterCompletion: boolean): Promise<ShareStore> {
    // watcher
    return new Promise((resolve, reject) => {
      this.requestStatusCheckId = Number(
        setInterval(async () => {
          try {
            const latestShareTransferStore = await this.getShareTransferStore();
            if (!this.currentEncKey) throw new Error("Missing current enc key");
            if (!latestShareTransferStore[encPubKeyX]) {
              this._cleanUpCurrentRequest();
              reject(new Error("User cancelled request"));
            } else if (latestShareTransferStore[encPubKeyX].encShareInTransit) {
              const shareStoreBuf = await decrypt(toPrivKeyECC(this.currentEncKey), latestShareTransferStore[encPubKeyX].encShareInTransit);
              const receivedShare = ShareStore.fromJSON(JSON.parse(shareStoreBuf.toString()));
              await this.tbSDK.inputShareStoreSafe(receivedShare);
              if (deleteRequestAfterCompletion) {
                await this.deleteShareTransferStore(encPubKeyX);
              }
              this._cleanUpCurrentRequest();
              resolve(receivedShare);
            }
          } catch (err) {
            this._cleanUpCurrentRequest();
            reject(err);
          }
        }, this.requestStatusCheckInterval)
      );
    });
  }

  async cancelRequestStatusCheck(): Promise<void> {
    clearInterval(this.requestStatusCheckId);
  }

  async deleteShareTransferStore(encPubKey: string): Promise<void> {
    const currentShareTransferStore = await this.getShareTransferStore();
    delete currentShareTransferStore[encPubKey];
    await this.setShareTransferStore(currentShareTransferStore);
  }

  async resetShareTransferStore(): Promise<void> {
    const metadata = this.tbSDK.getMetadata();
    const shareTransferStorePointer = { pointer: new BN(generatePrivate()) };
    metadata.setGeneralStoreDomain(this.moduleName, shareTransferStorePointer);
    await this.tbSDK.syncShareMetadata();
  }
}

export default ShareTransferModule;
