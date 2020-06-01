import React, { useReducer, useEffect } from 'react';
import { StyleSheet, Text, View, Dimensions, Platform } from 'react-native';
import RNCallKeep from 'react-native-callkeep';
import ramdomUuid from 'uuid-random';
import {Container, Content, Form, Input, Item, Label, Button, Footer } from 'native-base';
import { RTCPeerConnection, RTCSessionDescription, MediaStream, mediaDevices, RTCView } from 'react-native-webrtc';
import Wazo from '@wazo/sdk/lib/simple';
import AsyncStorage from "@react-native-community/async-storage";

// Polyfill WebRTC
global.MediaStream = MediaStream;
global.RTCSessionDescription = RTCSessionDescription;
global.RTCPeerConnection = RTCPeerConnection;
global.navigator.mediaDevices = {
  ...global.navigator.mediaDevices,
  getUserMedia: mediaDevices.getUserMedia,
};

const styles = StyleSheet.create({
  content: {
    flex: 1,
    position: 'relative',
  },
  form: {
    backgroundColor: 'white',
  },
  buttonsContainer: {
    flex: 1,
    paddingHorizontal: 10,
    flexDirection: 'row',
  },
  button: {
    margin: 10,
    flex: 1,
    alignItems: 'center',
    textAlign: 'center',
  },
  centeredText: {
    flex: 1,
    alignItems: 'center',
    textAlign: 'center',
  },
  localVideo: {
    width: 100,
    height: 100,
    position: 'absolute',
    right: 10,
    bottom: 60,
  },
  remoteVideo: {
    flex: 1,
    position: 'absolute',
    left: 0,
    top: 0,
    margin: 0,
    padding: 0,
    aspectRatio: 1,
    width: Dimensions.get('window').width,
    height: Dimensions.get('window').height,
    overflow: 'hidden',
    alignItems: 'center',
  },
});

const isIOS = Platform.OS === 'ios';

const reducer = (state, action) => ({ ...state, ...action});
const initialState = {
  ready: false,
  currentSession: null,
  number: '8008',
  ringing: false,
  inCall: false,
  held: false,
  error: null,
  localStreamURL: null,
  remoteStreamURL: null,
};

const Dialer = ({ onLogout }) => {
  const [ state, dispatch ] = useReducer(reducer, initialState);
  const { currentSession, number, ringing, inCall, held, localStreamURL, remoteStreamURL, ready } = state;
  let currentCallId;
  let localStream;
  let remoteStream;

  const getCurrentCallId = () => {
    if (!currentCallId) {
      currentCallId = ramdomUuid().toLowerCase();
    }

    return currentCallId;
  };

  const init = async () => {
    await initializeWebRtc();
    await initializeCallKeep();
    displayLocalVideo();

    dispatch({ ready: true });
  };

  const initializeWebRtc = async () => {
    await Wazo.Phone.connect({ audio: true, video: true });

    Wazo.Phone.on(Wazo.Phone.ON_CALL_INCOMING, callSession => {
      setupCallSession(callSession);
      dispatch({ ringing: true, currentSession: callSession });

      // Tell callkeep that we a call is incoming
      const { number } = callSession;
      // RNCallKeep.displayIncomingCall(getCurrentCallId(), number, number, 'number', callSession.cameraEnabled);
    });
  };

  const initializeCallKeep = async () => {
    try {
      RNCallKeep.setup({
      ios: {
        appName: 'WazoReactNativeDemo',
      },
      android: {
        alertTitle: 'Permissions required',
        alertDescription: 'This application needs to access your phone accounts',
        cancelButton: 'Cancel',
        okButton: 'ok',
      }
    });
      RNCallKeep.setAvailable(true);
    } catch (err) {
      console.error('initializeCallKeep error:', err.message);
    }

    // Add RNCallKit Events
    RNCallKeep.addEventListener('didReceiveStartCallAction', onNativeCall);
    RNCallKeep.addEventListener('answerCall', onAnswerCallAction);
    RNCallKeep.addEventListener('endCall', onEndCallAction);
    RNCallKeep.addEventListener('didDisplayIncomingCall', onIncomingCallDisplayed);
    RNCallKeep.addEventListener('didPerformSetMutedCallAction', onToggleMute);
    RNCallKeep.addEventListener('didPerformDTMFAction', onDTMF);
  };

  const getLocalStream = () => mediaDevices.getUserMedia({
    audio: true,
    video: {
      mandatory: {
        minWidth: 500,
        minHeight: 300,
        minFrameRate: 30
      },
      facingMode: 'user',
    }
  });

  const displayLocalVideo = () => {
    getLocalStream().then((stream) => {
      dispatch({ localStreamURL: stream.toURL() });
    });
  };

  const setupCallSession = callSession => {
    dispatch({ currentSession:  callSession });

    Wazo.Phone.on(Wazo.Phone.ON_CALL_FAILED, (response, cause) => {
      dispatch({ error: cause, ringing: false, inCall: false });
    });

    Wazo.Phone.on(Wazo.Phone.ON_CALL_ENDED, () => {
      onCallTerminated();
    });

    Wazo.Phone.on(Wazo.Phone.ON_CALL_ACCEPTED, () => {
      const session = Wazo.Phone.getCurrentSipSession();
      // Setup local stream
      if (callSession.cameraEnabled) {
        const { peerConnection } = session.sessionDescriptionHandler;
        localStream = peerConnection.getLocalStreams().find(stream => !!stream.getVideoTracks().length);
        remoteStream = peerConnection.getRemoteStreams().find(stream => !!stream.getVideoTracks().length);

        console.log('localStream', localStream.toURL());

        dispatch({
          localStreamURL: localStream ? localStream.toURL() : null,
          remoteStreamURL: remoteStream ? remoteStream.toURL() : null,
        });
      }
    });
  };

  const call = async (number, video = false) => {
    const session = await Wazo.Phone.call(number, video);
    setupCallSession(session);

    dispatch({ inCall: true, ringing: false });

    // Tell callkeep that we are in call
    // RNCallKeep.startCall(getCurrentCallId(), number, number, 'number', video);
  };

  const answer = () => {
    dispatch({ inCall: true, ringing: false });
    RNCallKeep.setCurrentCallActive();

    Wazo.Phone.accept(currentSession, currentSession.cameraEnabled);
  };

  const hangup = () => {
    const currentCallId = getCurrentCallId();
    if (!currentSession || !currentCallId) {
      return;
    }

    Wazo.Phone.hangup(currentSession);

    onCallTerminated();
  };

  const onCallTerminated = currentCallId => {
    if (currentCallId) {
      RNCallKeep.endCall(currentCallId);
    }
    dispatch({
      inCall: false,
      ringing: false,
      currentCallId: null,
      currentSession: null,
      remoteStreamURL: null,
      localStreamURL: null,
    });

    if (remoteStream) {
      remoteStream.release();
      remoteStream = null;
    }
    if (localStream) {
      localStream.release();
      localStream = null;
    }

    displayLocalVideo();
  };

  const onAnswerCallAction = ({ callUUID }) => {
    // called when the user answer the incoming call
    answer();
  };

  const onIncomingCallDisplayed = ({ callUUID, handle, fromPushKit }) => {
    // You will get this event after RNCallKeep finishes showing incoming call UI
    // You can check if there was an error while displaying
  };

  const onNativeCall = ({ handle }) => {
    // _onOutGoingCall on android is also called when making a call from the app
    // so we have to check in order to not making 2 calls
    if (inCall) {
      return;
    }
    // Called when performing call from native Contact app
    call(handle);
  };

  const toggleHold = () => {
    Wazo.Phone[held ? 'unhold' : 'hold'](currentSession);
    dispatch({ held: !held });
  };

  const onEndCallAction = ({ callUUID }) => {
    hangup();
  };

  const onToggleMute = (muted) => {
    // Called when the system or the user mutes a call
    Wazo.Phone[muted ? 'mute' : 'unmute'](currentSession);
  };

  const onDTMF = (action) => {
    console.log('onDTMF', action);
  };

  const logout = async () => {
    Wazo.Auth.logout();
    await AsyncStorage.removeItem('token');

    onLogout();
  };

  useEffect(() => {
    init();
  }, []);

  console.log('localStreamURL', localStreamURL);

  return (
    <Container style={styles.content}>
      {!isIOS && localStreamURL && (<RTCView mirror streamURL={localStreamURL} style={styles.localVideo} zOrder={1} />)}

      {remoteStreamURL && <RTCView objectFit="cover" streamURL={remoteStreamURL} style={styles.remoteVideo} zOrder={15} />}

      <Content style={styles.content}>
        <Form style={styles.form}>
         <Item stackedLabel>
           <Label>Extension</Label>
           <Input
             autoCapitalize="none"
             onChangeText={value => dispatch({ number: value })}
             value={number}
             onSubmitEditing={call}
           />
         </Item>
        </Form>

        {!ringing && !inCall && (
          <View style={styles.buttonsContainer}>
            <Button block disabled={!ready} onPress={() => call(number, false)} style={styles.button}>
              <Text>Call</Text>
            </Button>
            <Button block disabled={!ready} onPress={() => call(number, true)} style={styles.button}>
              <Text>Video call</Text>
            </Button>
          </View>
        )}
        {ringing && (
          <Button onPress={answer} style={styles.button}>
            <Text style={styles.centeredText}>
              Answer {currentSession.cameraEnabled ? 'video': 'audio'} call from {currentSession.number}
              </Text>
          </Button>
        )}

        {inCall && (
          <View style={styles.buttonsContainer}>
            <Button block onPress={hangup} style={styles.button}>
              <Text>Hangup</Text>
            </Button>
            <Button block onPress={toggleHold} style={styles.button}>
              <Text>{held ? 'Unhold' : 'Hold' }</Text>
            </Button>
          </View>
        )}
      </Content>
      {isIOS && localStreamURL && (<RTCView mirror streamURL={localStreamURL} style={styles.localVideo} zOrder={1} />)}
      <Footer>
        <Button transparent onPress={logout}>
          <Text>Logout</Text>
        </Button>
      </Footer>
    </Container>
  );
};

export default Dialer;
