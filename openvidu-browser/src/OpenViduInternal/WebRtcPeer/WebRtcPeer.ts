/*
 * (C) Copyright 2017-2020 OpenVidu (https://openvidu.io)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import freeice = require('freeice');
import uuid = require('uuid');
import platform = require('platform');

export interface WebRtcPeerConfiguration {
    mediaConstraints: {
        audio: boolean,
        video: boolean
    };
    simulcast: boolean;
    onicecandidate: (event) => void;
    iceServers: RTCIceServer[] | undefined;
    mediaStream?: MediaStream;
    mode?: 'sendonly' | 'recvonly' | 'sendrecv';
    id?: string;
}

export class WebRtcPeer {

    pc: RTCPeerConnection;
    id: string;
    remoteCandidatesQueue: RTCIceCandidate[] = [];
    localCandidatesQueue: RTCIceCandidate[] = [];

    iceCandidateList: RTCIceCandidate[] = [];

    private candidategatheringdone = false;

    constructor(private configuration: WebRtcPeerConfiguration) {
        this.configuration.iceServers = (!!this.configuration.iceServers && this.configuration.iceServers.length > 0) ? this.configuration.iceServers : freeice();

        this.pc = new RTCPeerConnection({ iceServers: this.configuration.iceServers });
        this.id = !!configuration.id ? configuration.id : uuid.v4();

        this.pc.onicecandidate = event => {
            if (!!event.candidate) {
                const candidate: RTCIceCandidate = event.candidate;
                if (candidate) {
                    this.localCandidatesQueue.push(<RTCIceCandidate>{ candidate: candidate.candidate });
                    this.candidategatheringdone = false;
                    this.configuration.onicecandidate(event.candidate);
                } else if (!this.candidategatheringdone) {
                    this.candidategatheringdone = true;
                }
            }
        };

        this.pc.onsignalingstatechange = () => {
            if (this.pc.signalingState === 'stable') {
                while (this.iceCandidateList.length > 0) {
                    this.pc.addIceCandidate(<RTCIceCandidate>this.iceCandidateList.shift());
                }
            }
        };

        this.start();
    }

    /**
     * This function creates the RTCPeerConnection object taking into account the
     * properties received in the constructor. It starts the SDP negotiation
     * process: generates the SDP offer and invokes the onsdpoffer callback. This
     * callback is expected to send the SDP offer, in order to obtain an SDP
     * answer from another peer.
     */
    start(): Promise<any> {
        return new Promise((resolve, reject) => {
            if (this.pc.signalingState === 'closed') {
                reject('The peer connection object is in "closed" state. This is most likely due to an invocation of the dispose method before accepting in the dialogue');
            }
            if (!!this.configuration.mediaStream) {
                for (const track of this.configuration.mediaStream.getTracks()) {
                    this.pc.addTrack(track, this.configuration.mediaStream);
                }
                resolve();
            }
        });
    }

    /**
     * This method frees the resources used by WebRtcPeer
     */
    dispose() {
        console.debug('Disposing WebRtcPeer');
        if (this.pc) {
            if (this.pc.signalingState === 'closed') {
                return;
            }
            this.pc.close();
            this.remoteCandidatesQueue = [];
            this.localCandidatesQueue = [];
        }
    }

    /**
     * Function that creates an offer, sets it as local description and returns the offer param
     * to send to OpenVidu Server (will be the remote description of other peer)
     */
    generateOffer(): Promise<string> {
        return new Promise((resolve, reject) => {
            let offerAudio, offerVideo = true;

            // Constraints must have both blocks
            if (!!this.configuration.mediaConstraints) {
                offerAudio = (typeof this.configuration.mediaConstraints.audio === 'boolean') ?
                    this.configuration.mediaConstraints.audio : true;
                offerVideo = (typeof this.configuration.mediaConstraints.video === 'boolean') ?
                    this.configuration.mediaConstraints.video : true;
            }

            const constraints: RTCOfferOptions = {
                offerToReceiveAudio: (this.configuration.mode !== 'sendonly' && offerAudio),
                offerToReceiveVideo: (this.configuration.mode !== 'sendonly' && offerVideo)
            };

            console.debug('RTCPeerConnection constraints: ' + JSON.stringify(constraints));

            if (platform.name === 'Safari' && platform.ua!!.indexOf('Safari') !== -1) {
                // Safari (excluding Ionic), at least on iOS just seems to support unified plan, whereas in other browsers is not yet ready and considered experimental
                if (offerAudio) {
                    this.pc.addTransceiver('audio', {
                        direction: this.configuration.mode,
                    });
                }

                if (offerVideo) {
                    this.pc.addTransceiver('video', {
                        direction: this.configuration.mode,
                    });
                }

                this.pc
                    .createOffer()
                    .then(offer => {
                        console.debug('Created SDP offer');
                        return this.pc.setLocalDescription(offer);
                    })
                    .then(() => {
                        const localDescription = this.pc.localDescription;

                        if (!!localDescription) {
                            console.debug('Local description set', localDescription.sdp);
                            resolve(localDescription.sdp);
                        } else {
                            reject('Local description is not defined');
                        }
                    })
                    .catch(error => reject(error));

            } else {

                // Rest of platforms
                this.pc.createOffer(constraints).then(offer => {
                    console.debug('Created SDP offer');
                    return this.pc.setLocalDescription(offer);
                })
                    .then(() => {
                        const localDescription = this.pc.localDescription;
                        if (!!localDescription) {
                            console.debug('Local description set', localDescription.sdp);
                            resolve(localDescription.sdp);
                        } else {
                            reject('Local description is not defined');
                        }
                    })
                    .catch(error => reject(error));
            }
        });
    }

    /**
     * Function invoked when a SDP answer is received. Final step in SDP negotiation, the peer
     * just needs to set the answer as its remote description
     */
    processAnswer(sdpAnswer: string, needsTimeoutOnProcessAnswer: boolean): Promise<string> {
        return new Promise((resolve, reject) => {
            const answer: RTCSessionDescriptionInit = {
                type: 'answer',
                sdp: sdpAnswer
            };
            console.debug('SDP answer received, setting remote description');

            if (this.pc.signalingState === 'closed') {
                reject('RTCPeerConnection is closed');
            }
            if (platform['isIonicIos']) {
                // Ionic iOS platform
                if (needsTimeoutOnProcessAnswer) {
                    // 400 ms have not elapsed yet since first remote stream triggered Stream#initWebRtcPeerReceive
                    setTimeout(() => {
                        console.info('setRemoteDescription run after timeout for Ionic iOS device');
                        this.pc.setRemoteDescription(new RTCSessionDescription(answer)).then(() => resolve()).catch(error => reject(error));
                    }, 250);
                } else {
                    // 400 ms have elapsed
                    this.pc.setRemoteDescription(new RTCSessionDescription(answer)).then(() => resolve()).catch(error => reject(error));
                }
            } else {
                // Rest of platforms
                this.pc.setRemoteDescription(answer).then(() => resolve()).catch(error => reject(error));
            }
        });
    }

    /**
     * Callback function invoked when an ICE candidate is received
     */
    addIceCandidate(iceCandidate: RTCIceCandidate): Promise<void> {
        return new Promise((resolve, reject) => {
            console.debug('Remote ICE candidate received', iceCandidate);
            this.remoteCandidatesQueue.push(iceCandidate);
            switch (this.pc.signalingState) {
                case 'closed':
                    reject(new Error('PeerConnection object is closed'));
                    break;
                case 'stable':
                    if (!!this.pc.remoteDescription) {
                        this.pc.addIceCandidate(iceCandidate).then(() => resolve()).catch(error => reject(error));
                    } else {
                        this.iceCandidateList.push(iceCandidate);
                        resolve();
                    }
                    break;
                default:
                    this.iceCandidateList.push(iceCandidate);
                    resolve();
            }
        });
    }

    addIceConnectionStateChangeListener(otherId: string) {
        this.pc.oniceconnectionstatechange = () => {
            const iceConnectionState: RTCIceConnectionState = this.pc.iceConnectionState;
            switch (iceConnectionState) {
                case 'disconnected':
                    // Possible network disconnection
                    console.warn('IceConnectionState of RTCPeerConnection ' + this.id + ' (' + otherId + ') change to "disconnected". Possible network disconnection');
                    break;
                case 'failed':
                    console.error('IceConnectionState of RTCPeerConnection ' + this.id + ' (' + otherId + ') to "failed"');
                    break;
                case 'closed':
                    console.log('IceConnectionState of RTCPeerConnection ' + this.id + ' (' + otherId + ') change to "closed"');
                    break;
                case 'new':
                    console.log('IceConnectionState of RTCPeerConnection ' + this.id + ' (' + otherId + ') change to "new"');
                    break;
                case 'checking':
                    console.log('IceConnectionState of RTCPeerConnection ' + this.id + ' (' + otherId + ') change to "checking"');
                    break;
                case 'connected':
                    console.log('IceConnectionState of RTCPeerConnection ' + this.id + ' (' + otherId + ') change to "connected"');
                    break;
                case 'completed':
                    console.log('IceConnectionState of RTCPeerConnection ' + this.id + ' (' + otherId + ') change to "completed"');
                    break;
            }
        }
    }

}


export class WebRtcPeerRecvonly extends WebRtcPeer {
    constructor(configuration: WebRtcPeerConfiguration) {
        configuration.mode = 'recvonly';
        super(configuration);
    }
}

export class WebRtcPeerSendonly extends WebRtcPeer {
    constructor(configuration: WebRtcPeerConfiguration) {
        configuration.mode = 'sendonly';
        super(configuration);
    }
}

export class WebRtcPeerSendrecv extends WebRtcPeer {
    constructor(configuration: WebRtcPeerConfiguration) {
        configuration.mode = 'sendrecv';
        super(configuration);
    }
}