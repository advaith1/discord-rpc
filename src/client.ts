import axios, { AxiosResponse, Method } from "axios";
import { APIApplication, OAuth2Scopes } from "discord-api-types/v10";
import { EventEmitter } from "stream";
import TypedEmitter from "typed-emitter";
import { v4 as uuidv4 } from "uuid";
import { ClientUser } from "./structures/ClientUser";
import { CMD, CommandIncoming, EVT, Transport } from "./structures/Transport";
import { IPCTransport } from "./transport/ipc";
import { WebsocketTransport } from "./transport/websocket";

export type AuthorizeOptions = {
    scopes?: (OAuth2Scopes | OAuth2Scopes[keyof OAuth2Scopes])[];
    clientSecret?: string;
    rpcToken?: boolean;
    redirectUri?: string;
    prompt?: string;
};

export interface ClientOptions {
    clientId: string;
    accessToken?: string;
    transport?: {
        type?: "ipc" | "websocket" | { new (client: Client, ...args: any): Transport };
        formatPath?: (id: number, snap?: boolean) => string;
    };
    debug?: boolean;
}

export type ClientEvents = {
    ready: () => void;
    connected: () => void;
    disconnected: () => void;
};

export class Client extends (EventEmitter as new () => TypedEmitter<ClientEvents>) {
    clientId: string;
    accessToken: string;

    readonly transport: Transport;
    readonly debug: boolean;

    user?: ClientUser;
    application?: APIApplication;

    endPoint: string = "https://discord.com/api";
    origin: string = "https://localhost";

    private connectionPromise?: Promise<void>;
    private _nonceMap = new Map<string, { resolve: (value?: any) => void; reject: (reason?: any) => void }>();

    constructor({ clientId, accessToken, transport, debug }: ClientOptions) {
        super();

        this.clientId = clientId;
        this.accessToken = accessToken || "";

        this.debug = !!debug; // Funky Javascript :)

        this.transport =
            transport && transport.type && transport.type != "ipc"
                ? transport.type === "websocket"
                    ? new WebsocketTransport(this)
                    : new transport.type(this)
                : new IPCTransport(this, {
                      formatPathFunction: transport?.formatPath
                  });

        this.transport.on("message", (message) => {
            if (message.cmd === "DISPATCH" && message.evt === "READY") {
                if (message.data.user) this.user = new ClientUser(this, message.data.user);
                this.emit("connected");
            } else {
                if (message.nonce && this._nonceMap.has(message.nonce)) {
                    this._nonceMap.get(message.nonce)?.resolve(message);
                    this._nonceMap.delete(message.nonce);
                }

                this.emit((message as any).evt, message.data);
            }
        });
    }

    async fetch(
        method: Method | string,
        path: string,
        { data, query }: { data?: any; query?: string }
    ): Promise<AxiosResponse<any>> {
        return await axios.request({
            method,
            url: `${this.endPoint}${path}${query ? new URLSearchParams(query) : ""}`,
            data,
            headers: {
                Authorization: `Bearer ${this.accessToken}`
            }
        });
    }

    async request(cmd: CMD, args?: any, evt?: EVT): Promise<CommandIncoming> {
        return new Promise((resolve, reject) => {
            const nonce = uuidv4();

            this.transport.send({ cmd, args, evt, nonce });
            this._nonceMap.set(nonce, { resolve, reject });
        });
    }

    async authenticate(accessToken: string): Promise<void> {
        const { application, user } = (await this.request("AUTHENTICATE", { access_token: accessToken })).data;
        this.accessToken = accessToken;
        this.application = application;
        this.user = user;
        this.emit("ready");
    }

    async authorize({ scopes, clientSecret, rpcToken, redirectUri, prompt }: AuthorizeOptions = {}): Promise<string> {
        if (clientSecret && rpcToken === true) {
            const data = (
                await this.fetch("POST", "/oauth2/token/rpc", {
                    data: {
                        client_id: this.clientId,
                        client_secret: clientSecret
                    }
                })
            ).data;
            rpcToken = data.rpc_token;
        }

        const { code } = (await this.request("AUTHORIZE", {
            scopes,
            client_id: this.clientId,
            prompt,
            rpc_token: rpcToken,
            redirect_uri: redirectUri
        })) as { [key: string]: any };

        const response = (
            await this.fetch("POST", "/oauth2/token", {
                data: {
                    client_id: this.clientId,
                    client_secret: clientSecret,
                    code,
                    grant_type: "authorization_code",
                    redirect_uri: redirectUri
                }
            })
        ).data;

        return response.access_token;
    }

    async connect(): Promise<void> {
        if (this.connectionPromise) return this.connectionPromise;

        this.connectionPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("TRANSPORT_CONNECTION_TIMEOUT")), 10e3);
            timeout.unref();

            this.once("connected", () => {
                clearTimeout(timeout);
                resolve();
            });

            this.transport.once("close", () => {
                this._nonceMap.forEach((promise) => {
                    promise.reject(new Error("connection closed"));
                });
                this.emit("disconnected");
                reject(new Error("connection closed"));
            });

            this.transport.connect();
        });

        return this.connectionPromise;
    }

    async login(options: { accessToken?: string } & AuthorizeOptions = {}): Promise<void> {
        let { accessToken, scopes } = options;

        await this.connect();

        if (!scopes) {
            this.emit("ready");
            return;
        }

        if (!accessToken) accessToken = await this.authorize({ scopes });
        if (!accessToken) return;

        await this.authenticate(accessToken);
    }

    async destroy(): Promise<void> {
        await this.transport.close();
    }
}
