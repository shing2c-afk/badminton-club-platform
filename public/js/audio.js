// public/js/audio.js

/**
 * 웹 브라우저 음성 합성(TTS)을 이용한 안내 방송 함수
 * @param {string} message - 음성으로 출력할 텍스트 메시지
 */
// public/js/audio.js
// public/js/audio.js

function playVoiceAnnouncement(message) {
    if (!('speechSynthesis' in window)) {
        console.warn('이 브라우저는 음성 합성을 지원하지 않는 브라우저입니다.');
        return;
    }

    window.speechSynthesis.cancel();

    let refinedMessage = message
        .replace(/1번/g, '일 번')
        .replace(/2번/g, '이 번')
        .replace(/3번/g, '삼 번')
        .replace(/4번/g, '사 번')
        .replace(/5번/g, '오 번')
        .replace(/6번/g, '육 번')
        .replace(/7번/g, '칠 번')
        .replace(/8번/g, '팔 번')
        .replace(/9번/g, '구 번');

    const utterance = new SpeechSynthesisUtterance(refinedMessage);
    utterance.lang = 'ko-KR';
    
    // 💡 속도를 1.0으로 살짝 높여서 뜸을 줄이고 매끄럽게 연결
    utterance.rate = 1.2; 
    utterance.pitch = 1.05; 

    const voices = window.speechSynthesis.getVoices();
    const koreanVoice = voices.find(v => v.lang.includes('ko') && (v.name.includes('Google') || v.name.includes('Natural') || v.name.includes('Heami')));
    if (koreanVoice) {
        utterance.voice = koreanVoice;
    }

    window.speechSynthesis.speak(utterance);
}

if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
    };
}