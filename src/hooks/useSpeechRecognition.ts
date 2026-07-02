import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';

interface UseSpeechRecognitionOptions {
  setInputMessage: Dispatch<SetStateAction<string>>;
}

export function useSpeechRecognition({ setInputMessage }: UseSpeechRecognitionOptions) {
  const [isListening, setIsListening] = useState(false);
  const [recognitionError, setRecognitionError] = useState<string | null>(null);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [showVoiceMockModal, setShowVoiceMockModal] = useState(false);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSpeechSupported(false);
      return;
    }

    try {
      const rec = new SpeechRecognition();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = 'zh-CN';

      rec.onstart = () => {
        setIsListening(true);
        setRecognitionError(null);
      };

      rec.onresult = (event: any) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }

        const currentText = finalTranscript || interimTranscript;
        if (currentText) {
          setInputMessage(currentText);
        }
      };

      rec.onerror = (event: any) => {
        console.warn('Speech recognition warning/error:', event);
        if (event.error === 'not-allowed') {
          setRecognitionError('麦克风权限被拒绝，请在浏览器或手机上授予麦克风权限。');
        } else if (event.error === 'no-speech') {
          // Ignore silent warning.
        } else {
          setRecognitionError(`识别错误: ${event.error}`);
        }
        setIsListening(false);
      };

      rec.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = rec;
    } catch (e) {
      console.error('Failed to init speech recognition:', e);
      setSpeechSupported(false);
    }

    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch (err) {}
      }
    };
  }, [setInputMessage]);

  const toggleListening = () => {
    if (!speechSupported) {
      setShowVoiceMockModal(true);
      return;
    }

    if (isListening) {
      try {
        recognitionRef.current?.stop();
      } catch (e) {}
      setIsListening(false);
    } else {
      setInputMessage('');
      setRecognitionError(null);
      try {
        recognitionRef.current?.start();
      } catch (e: any) {
        console.error('Start recognition error:', e);
        setRecognitionError('启动语音硬件失败。已自动切换为仿真智能语音输入。');
        setShowVoiceMockModal(true);
      }
    }
  };

  return {
    isListening,
    recognitionError,
    speechSupported,
    showVoiceMockModal,
    setShowVoiceMockModal,
    toggleListening
  };
}
