import { createWorker, types } from "mediasoup";
import { Server, Socket } from 'socket.io'
import { pino } from "pino";
import { uuid } from "uuidv4"
import { DefaultEventsMap } from "socket.io/dist/typed-events";
import { WebRtcServer } from "mediasoup/node/lib/WebRtcServer";
import { RtpCapabilities, RtpParameters } from "mediasoup/node/lib/RtpParameters";
import { DtlsParameters, WebRtcTransport } from "mediasoup/node/lib/WebRtcTransport";
import { type } from "os";
import { createServer } from 'http'
import { Router } from "mediasoup/node/lib/Router";
import { Worker } from "mediasoup/node/lib/Worker";
import { trace } from "console";
import './monitor'

const PORT = process.env.PORT || 3001
const httpServer = createServer();
const io = new Server<MediasoupEvents, DefaultEventsMap>(httpServer, {
    cors: {
        origin: '*'
    }
})
const logger = pino({
    transport: {
        target: 'pino-pretty'
    }
})

httpServer.listen(8081, '0.0.0.0', () => {logger.info("Listen to: " + 8081)})

// { worker: types.WorkerSettings } 
const config = {
    // Worker settings
    worker: {
        rtcMinPort: 40000,
        rtcMaxPort: 40100,
        logLevel: "debug",
        logTags: [
            'info',
            'ice',
            'dtls',
            'rtp',
            'srtp',
            'rtcp',
            'rtx',
            'bwe',
            'score',
            'simulcast',
            'svc'
        ],
    },
    // Router settings
    router: {
        mediaCodecs:
        [
            {
                kind: 'audio',
                mimeType: 'audio/opus',
                clockRate: 48000,
                channels: 2
            },
            {
                kind: 'video',
                mimeType: 'video/VP8',
                clockRate: 90000,
                parameters:
                {
                    'x-google-start-bitrate': 1000
                }
            },
        ]
    },
    webRtcServerOptions: {
        listenInfos :
        [
            {
                protocol    : 'udp' as types.TransportProtocol,
                ip          : process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
                announcedIp : process.env.MEDIASOUP_ANNOUNCED_IP || '131.112.183.91',
                port        : 40011
            },
            {
                protocol    : 'tcp' as types.TransportProtocol,
                ip          : process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
                announcedIp : process.env.MEDIASOUP_ANNOUNCED_IP || '131.112.183.91',
                port        : 40011
            }
        ],
    },
    // WebRtcTransport settings
    webRtcTransport: {
        // listenIps: [
        //     { ip: '127.0.0.1' },
        //     { ip: '133.167.113.61' },
        //     { ip: '0.0.0.0', announcedIp: '133.167.113.61'}
        // ],
        enableUdp: true,
        // enableTcp: true,
        // preferUdp: true,
        // enableSctp: true, // add
        maxIncomingBitrate: 1500000,
        initialAvailableOutgoingBitrate: 1000000,
    }
}

interface Store {
    router: types.Router | undefined,
    worker: types.Worker | undefined
    producerTransport?: types.Transport,
    producer?: types.Producer,
    consumerTransport?: types.Transport,
    consumer?: types.Consumer,
    webRtcServer: types.WebRtcServer | undefined,
    sessions: Map<string, Session>
}

const store: Store = {
    router: undefined,
    worker: undefined,
    webRtcServer: undefined,
    sessions: new Map()
}

class Session {
    id: string
    transports = new Map<string, types.WebRtcTransport>()
    producers = new Map<string, types.Producer>()
    consumers = new Map<string, types.Consumer>()

    constructor(id: string) {
        this.id = id
    }

    close() {
        logger.info(`Since this session ${this.id} has been closed, clear all unused resources.`)

        logger.info(`Resources: producer * ${this.producers.size}`)
        logger.info(`Resources: consumer * ${this.consumers.size}`)
        logger.info(`Resources: transport * ${this.transports.size}`)

        this.producers.forEach(p => {p.close()})
        this.consumers.forEach(c => {c.close()})
        this.transports.forEach(t => {t.close()})
    }
}

interface Request {
    method: string,
    payload: any
}
interface Response {
    method: string,
    payload: any
}

interface MediasoupEvents {
    'ms-request': (request: Request, cb: (response: Response) => void) => void
}

io.on("connection", async (socket) => {
    const router = store.router

    logger.info("New socket connection: " + socket.id)

    store.sessions.set(socket.id, new Session(socket.id))

    socket.on("disconnect", (reason) => {
        logger.info(`Session ${socket.id} has been finished, since ${reason}.`)

        store.sessions.get(socket.id)?.close()

        store.sessions.delete(socket.id)
    })

    socket.on('ms-request', async (request, cb) => {
        logger.info(`Received a new ms-request type: ${request.method}.`)

        var session = store.sessions.get(socket.id)

        if (session) {
            try {
                switch(request.method) {
                    case 'getRouterRtpCapabilities':
                        cb({ method: request.method, payload: router!.rtpCapabilities })
                        break;
                    case 'createTransport':
                        var type = request.payload.type as 'produce' | 'consume'
                        // var response = await onCreateTransport(type)
                        var response = await onCreateTransportWithSession(session, type)
    
                        cb({method: request.method, payload: response})
                        break
                    case 'connectTransport':
                        var remote = request.payload as { id: string, dtlsParameters: any }

                        var transport = session.transports.get(remote.id)

                        await onConnectTransport(transport as WebRtcTransport, remote.dtlsParameters)
                        cb({ method: request.method, payload: transport!.id })
                        break;
                    case 'createProducer':
                        var producer = await onProduceWithSession(session, request.payload.transportId, request.payload.options)

                        cb({ method: request.method, payload: producer.id })
                        
                        break;
                    case 'createConsumer':
                        if (router!.canConsume(request.payload.options)) {
                            var data = await onConsumeWithSession(session, request.payload.transportId, request.payload.options)

                            cb({ method: request.method, payload: data })
                        } 
                        break;
                    case 'pauseConsumer':
                        var consumer = session.consumers.get(request.payload.id as string)

                        await consumer!.pause()

                        cb({ method: request.method, payload: true })
                        break;
                    case 'resumeConsumer':
                        var consumer = session.consumers.get(request.payload.id as string)

                        await consumer!.resume()

                        cb({ method: request.method, payload: true })
                        break;
                    case 'pauseProducer':
                        var producer0 = session.producers.get(request.payload.id as string)

                        await producer0!.pause()

                        cb({ method: request.method, payload: true })
                        break;
                    case 'resumeProducer':
                        var producer0 = session.producers.get(request.payload.id as string)

                        await producer0!.resume()

                        cb({ method: request.method, payload: true })
                        break;
                }
            } catch (error) {
                logger.error(error)
            }
        }
        else {
            logger.info('Could not find target session.')
        }
    })
})

async function onCreateTransportWithSession(session: Session, type: 'produce' | 'consume') {
    if (type === 'consume') {
        let transport = await createTransportWithSession(session)

        session.transports.set(transport.id, transport)

        return toOptions(transport)
    }
    else {
        let transport = await createTransportWithSession(session)

        session.transports.set(transport.id, transport)

        return toOptions(transport)
    }
}

async function startMediasoup() {
    let worker = await createWorker(config.worker as types.WorkerSettings)

    worker.on('died', () => {
        logger.info("process died.")
        process.exit(1)
    })

    // const mediaCodecs = 
    const router = await worker.createRouter(config.router as types.RouterOptions)

    return { worker, router }
}

async function onConnectTransport(transport: types.WebRtcTransport, dtlsParameters: DtlsParameters) {
    await transport.connect({ dtlsParameters })
}

async function onProduceWithSession(session: Session, transportId: string, options: types.ProducerOptions) {
    options = {...options, paused: false}

    logger.info(`Try to produce. Transport[${transportId}]`)
    logger.info(session.transports)

    var transport = session.transports.get(transportId)
    var producer = await transport!.produce(options as types.ProducerOptions)

    session.producers.set(producer.id, producer)

    producer.on('transportclose', () => {
        logger.info(`The transport of producer ${producer.id} closed.`)
    })

    return producer
}

async function onConsumeWithSession(session: Session, transportId: string, options: types.ConsumerOptions) {
    var transport = session.transports.get(transportId)
    var consumer = await transport!.consume({ ...options, paused: true })

    session.consumers.set(consumer.id, consumer)

    return {
        id: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
    }
}

async function createTransportWithSession(session: Session) {
    const transport = await store.router!.createWebRtcTransport({...config.webRtcTransport, webRtcServer: store.webRtcServer as types.WebRtcServer})

    session.transports.set(transport.id, transport)

    transport.observer.on("close", () => {
        logger.info("[Observed] transport closed by some reason.")
    })
    transport.observer.on(`newproducer`, (producer) => {
        logger.info(`Transport[${transport.id}] have new producer-${producer.id}.`)
    })
    transport.observer.on(`newconsumer`, (consumer) => {
        logger.info(`Transport[${transport.id}] have new consumer-${consumer.id}.`)
    })

    return transport
}

function toOptions(transport: types.WebRtcTransport) {
    return {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters,
    }
}


async function main() {
    const { worker, router } = await startMediasoup()

    store.webRtcServer = await worker.createWebRtcServer({ listenInfos: config.webRtcServerOptions.listenInfos})
    store.worker = worker
    store.router = router
}

main()