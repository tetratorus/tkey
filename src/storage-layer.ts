import { post } from "@toruslabs/http-helpers";
import BN from "bn.js";
import stringify from "json-stable-stringify";
import { keccak256 } from "web3-utils";

import { getPubKeyECC, getPubKeyPoint, toPrivKeyEC, toPrivKeyECC } from "./base";
import {
  EncryptedMessage,
  IServiceProvider,
  IStorageLayer,
  StringifiedType,
  TorusStorageLayerAPIParams,
  TorusStorageLayerArgs,
} from "./baseTypes/commonTypes";
import { decrypt, encrypt } from "./utils";

class TorusStorageLayer implements IStorageLayer {
  enableLogging: boolean;

  hostUrl: string;

  serviceProvider: IServiceProvider;

  constructor({ enableLogging = false, hostUrl = "http://localhost:5051", serviceProvider }: TorusStorageLayerArgs) {
    this.enableLogging = enableLogging;
    this.hostUrl = hostUrl;
    this.serviceProvider = serviceProvider;
  }

  async getMetadata<T>(privKey?: BN): Promise<T> {
    const keyDetails = this.generateMetadataParams({}, privKey);
    const metadataResponse = await post<{ message: string }>(`${this.hostUrl}/get`, keyDetails);
    // returns empty object if object
    if (metadataResponse.message === "") {
      return {} as T;
    }
    const encryptedMessage = JSON.parse(atob(metadataResponse.message));

    let decrypted: Buffer;
    if (privKey) {
      decrypted = await decrypt(toPrivKeyECC(privKey), encryptedMessage);
    } else {
      decrypted = await this.serviceProvider.decrypt(encryptedMessage);
    }

    return JSON.parse(decrypted.toString()) as T;
  }

  async setMetadata<T>(input: T, privKey?: BN): Promise<{ message: string }> {
    const bufferMetadata = Buffer.from(stringify(input));
    let encryptedDetails: EncryptedMessage;
    if (privKey) {
      encryptedDetails = await encrypt(getPubKeyECC(privKey), bufferMetadata);
    } else {
      encryptedDetails = await this.serviceProvider.encrypt(bufferMetadata);
    }
    const serializedEncryptedDetails = btoa(stringify(encryptedDetails));
    const metadataParams = this.generateMetadataParams(serializedEncryptedDetails, privKey);
    return post<{ message: string }>(`${this.hostUrl}/set`, metadataParams);
  }

  async setMetadataBulk<T>(input: Array<T>, privKey?: Array<BN>): Promise<{ message: string }> {
    const encryptedDetailsArray = input.map(async (el, i) => {
      const bufferMetadata = Buffer.from(stringify(el));
      let encryptedDetails: EncryptedMessage;
      if (privKey[i]) {
        encryptedDetails = await encrypt(getPubKeyECC(privKey[i]), bufferMetadata);
      } else {
        encryptedDetails = await this.serviceProvider.encrypt(bufferMetadata);
      }
      const serializedEncryptedDetails = btoa(stringify(encryptedDetails));
      const metadataParams = this.generateMetadataParams(serializedEncryptedDetails, privKey[i]);
      return metadataParams;
    });
    const finalMetadataParams = await Promise.all(encryptedDetailsArray);
    return post<{ message: string }>(`${this.hostUrl}/bulk_set`, { shares: finalMetadataParams });
  }

  generateMetadataParams(message: unknown, privKey?: BN): TorusStorageLayerAPIParams {
    let sig: string;
    let pubX: string;
    let pubY: string;
    const setTKeyStore = {
      data: message,
      timestamp: new BN(~~(Date.now() / 1000)).toString(16),
    };
    const hash = keccak256(stringify(setTKeyStore)).slice(2);
    if (privKey) {
      const unparsedSig = toPrivKeyEC(privKey).sign(hash);
      sig = Buffer.from(unparsedSig.r.toString(16, 64) + unparsedSig.s.toString(16, 64) + new BN(0).toString(16, 2), "hex").toString("base64");
      const pubK = getPubKeyPoint(privKey);
      pubX = pubK.x.toString("hex");
      pubY = pubK.y.toString("hex");
    } else {
      const point = this.serviceProvider.retrievePubKeyPoint();
      sig = this.serviceProvider.sign(hash);
      pubX = point.getX().toString("hex");
      pubY = point.getY().toString("hex");
    }
    return {
      pub_key_X: pubX,
      pub_key_Y: pubY,
      set_data: setTKeyStore,
      signature: sig,
      namespace: "tkey",
    };
  }

  toJSON(): StringifiedType {
    return {
      enableLogging: this.enableLogging,
      hostUrl: this.hostUrl,
    };
  }

  static fromJSON(value: StringifiedType): TorusStorageLayer {
    const { enableLogging, hostUrl, serviceProvider } = value;
    return new TorusStorageLayer({ enableLogging, hostUrl, serviceProvider });
  }
}

export default TorusStorageLayer;
