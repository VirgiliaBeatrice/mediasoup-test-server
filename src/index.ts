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
const roomId = uuid()

httpServer.listen(8080, '0.0.0.0', () => {logger.info("Listen to: " + 8080)})

const producers = new Map<string, types.Producer>()
const consumers = new Map<string, types.Consumer>()
const transports = new Map<string, types.Transport>()

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
                announcedIp : process.env.MEDIASOUP_ANNOUNCED_IP || '133.167.113.61',
                port        : 40011
            },
            {
                protocol    : 'tcp' as types.TransportProtocol,
                ip          : process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
                announcedIp : process.env.MEDIASOUP_ANNOUNCED_IP || '133.167.113.61',
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
        producers.forEach(p => p.close())
        consumers.forEach(c => c.close())
        transports.forEach(t => t.close())
    }
}

let producerId: string

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
        logger.info(`Session has been finished, since ${reason}.`)

        store.sessions.get(socket.id)?.close()

        store.sessions.delete(socket.id)
    })

    socket.on('ms-request', async (request, cb) => {
        logger.info(`Received a new ms-request type: ${request.method}.`)
        // logger.info(`show details of ms-request: ${JSON.stringify(request)}`)

        try {
            switch(request.method) {
                case 'getRouterRtpCapabilities':
                    cb({ method: request.method, payload: router!.rtpCapabilities })
                    break;
                case 'createTransport':
                    var type = request.payload.type as 'produce' | 'consume'
                    var response = await onCreateTransport(type)

                    cb({method: request.method, payload: response})
                    break
                case 'connectTransport':
                    var item = request.payload as { id: string, dtlsParameters: any }
                    // logger.info(item)
                    var transport = store.producerTransport!.id === item.id? store.producerTransport! : store.consumerTransport!
                    // logger.info(transport)
                    // var transport = store.producerTransport!
                    await onConnectTransport(transport as WebRtcTransport, item.dtlsParameters)
                    cb({ method: request.method, payload: transport.id })
                    break;
                case 'createProducer':
                    if (store.producerTransport) {
                        await onProduce(store.producerTransport, request.payload)

                        cb({ method: request.method, payload: store.producer!.id })
                    }
                    break;
                case 'createConsumer':
                    var options = request.payload
                    // logger.info(`valid producer id: ${store.producer?.id}`)
                    // logger.info(`request producer id: ${options.producerId}`)

                    if (router?.canConsume(options)) {
                        if (store.consumerTransport) {
                            var data = await onConsume(store.consumerTransport, request.payload)

                            cb({ method: request.method, payload: data })
                        }
                    }

                    break;
            }
        } catch (error) {
            logger.error(error)
        }
    })
})

interface setRemoteRtpCapabilitiesOptions {
    producerId: string,
    rtpCapabilities: types.RtpCapabilities
}

async function onSetRemoteRtpCapabilities(options: setRemoteRtpCapabilitiesOptions) {
    if (router.canConsume(options)) {
        var consumer = await store.consumerTransport?.consume({ ... options, paused: true })

        store.consumer = consumer

        return {
            id: consumer?.id,
            parameters: consumer?.id
        }      
    }

    return undefined
}

let worker: any, router: types.Router

async function onCreateTransportWithSession(session: Session, type: 'produce' | 'consume') {
    if (type === 'consume') {
        let transport = await createTransport(store.router!)

        session.transports.set(transport.id, transport)

        return toOptions(transport)
    }
    else {
        let transport = await createTransport(store.router!)

        session.transports.set(transport.id, transport)

        return toOptions(transport)
    }
}

async function onCreateTransport(type: 'produce' | 'consume') {
    if (type === 'consume') {
        let transport = store.consumerTransport = await createTransport(store.router!)

        return toOptions(transport)
    }
    else {
        let transport = store.producerTransport = await createTransport(store.router!)

        return toOptions(transport)
    }
}


// worker => router => transport => transport.connect => assign producer/consumer

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

async function onProduceWithTransport(session: Session, transportId: string, options: types.ProducerOptions) {
    options = {...options, paused: false}

    logger.info('Try to produce.')

    var transport = session.transports.get(transportId)
    var producer = await transport!.produce(options as types.ProducerOptions)

    session.producers.set(producer.id, producer)

    // producer.observer.on('close', () => {
    //     logger.info('producer closed.')
    // })

    // producer.observer.on('pause', () => {
    //     logger.info('producer paused')
    // })

    // producer.observer.on('resume', () => {
    //     logger.info('producer resumed')
    // })

    // producer.on('score', (score) => {

    // })

    // producer.on('videoorientationchange', (videoOrientation) => {

    // })
    // producer.on('trace', (trace) => {
    //     // logger.info(trace.info)
    // })
    producer.on('transportclose', () => {
        logger.info('transport closed.')
    })
}

async function onProduce(transport: types.Transport, ...args: [any]) {
    var options = {...args[0], paused: false}

    logger.info("Try to produce." + JSON.stringify(args))
    var producer = await transport.produce(options as types.ProducerOptions)

    store.producer = producer
    // producer.enableTraceEvent(["rtp"])

    
    // setInterval(async () => {
    //     logger.info(await transport.getStats())
    // }, 1000)

    producer.observer.on('close', () => {
        logger.info('producer closed.')
    })

    producer.observer.on('pause', () => {
        logger.info('producer paused')
    })

    producer.observer.on('resume', () => {
        logger.info('producer resumed')
    })

    producer.on('score', (score) => {

    })

    producer.on('videoorientationchange', (videoOrientation) => {

    })
    producer.on('trace', (trace) => {
        // logger.info(trace.info)
    })
    producer.on('transportclose', () => {
        logger.info('transport closed.')
    })
    
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

async function onConsume(transport: types.Transport, ...args: [any]) {
    var consumer = await transport.consume({...args[0], paused: true})

    store.consumer = consumer

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

    return transport
}

async function createTransport(router: types.Router) {
    const transport = await router.createWebRtcTransport({...config.webRtcTransport, webRtcServer: store.webRtcServer as types.WebRtcServer})

    transports.set(transport.id, transport)

    // transport.enableTraceEvent(["probation", "bwe"])

    // transport.on('trace', (trace) => {
    //     // console.info(trace)
    // })

    transport.observer.on("close", () => {
        logger.info("[Observed] transport closed by some reason.")
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
    // store.producerTransport = await createTransport(router)
    // store.consumerTransport = await createTransport(router)
}

main()