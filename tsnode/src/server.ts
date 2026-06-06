import { DtfProtocolResponder } from "./protocol-responder.js";
import { DtfFileServerOptions, DtfPeer } from "./types.js";

export class DtfFileServer<TAddress = unknown> {
  readonly localPeer: DtfPeer;

  private readonly responder: DtfProtocolResponder<TAddress>;

  constructor(options: DtfFileServerOptions<TAddress>) {
    this.localPeer = options.localPeer;
    this.responder = new DtfProtocolResponder(options);
  }

  dispose(): void {
    this.responder.dispose();
  }
}

export function createDtfFileServer<TAddress>(options: DtfFileServerOptions<TAddress>): DtfFileServer<TAddress> {
  return new DtfFileServer(options);
}
