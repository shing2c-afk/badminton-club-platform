// public/js/audio.js

let audioQueue = [];
let isAudioPlaying = false;
let pendingAnnouncements = new Map(); // 코트별 30초 대기 타이머 관리 저장소
// audio.js 파일 하단이나 함수 선언부에 추가
window.cancelVoiceAnnouncement = function(announcementId) {
    if (announcementId && pendingAnnouncements.has(announcementId)) {
        clearTimeout(pendingAnnouncements.get(announcementId));
        pendingAnnouncements.delete(announcementId);
        console.log(`[Audio] ${announcementId}번 코트 30초 대기 방송 취소됨`);
    }
};

/**
 * 음성 안내 요청 함수
 * @param {string} message - 안내 메시지
 * @param {number} delaySeconds - 지연 시간 (초)
 * @param {string|number} announcementId - 코트 번호 등 타이머 구분을 위한 고유 ID (취소용)
 */
function playVoiceAnnouncement(message, delaySeconds = 0, announcementId = null) {
    if (!('speechSynthesis' in window)) {
        console.warn('이 브라우저는 음성 합성을 지원하지 않는 브라우저입니다.');
        return;
    }

    // 만약 동일한 ID(코트)로 이미 대기 중인 타이머가 있다면 기존 타이머 초기화 (중복 예약 방지)
    if (announcementId && pendingAnnouncements.has(announcementId)) {
        clearTimeout(pendingAnnouncements.get(announcementId));
        pendingAnnouncements.delete(announcementId);
    }

    // 딜레이가 있는 경우 지정된 시간(초)만큼 대기한 후 큐에 등록
    if (delaySeconds > 0) {
        const timerId = setTimeout(() => {
            audioQueue.push({ message, delaySeconds: 0 });
            if (announcementId) pendingAnnouncements.delete(announcementId);
            processAudioQueue();
        }, delaySeconds * 1000);

        // 나중에 입장이 확인되면 취소할 수 있도록 저장
        if (announcementId) {
            pendingAnnouncements.set(announcementId, timerId);
        }
        return;
    }

    // 딜레이가 없는 즉시 재생인 경우 바로 큐에 등록
    audioQueue.push({ message, delaySeconds: 0 });
    processAudioQueue();
}

/**
 * 30초 대기 중 회원이 코트에 입장했을 때 예약을 취소하는 함수
 * @param {string|number} announcementId - 취소할 코트 번호 등의 ID
 */
function cancelVoiceAnnouncement(announcementId) {
    if (announcementId && pendingAnnouncements.has(announcementId)) {
        clearTimeout(pendingAnnouncements.get(announcementId));
        pendingAnnouncements.delete(announcementId);
    }
}

function processAudioQueue() {
    if (isAudioPlaying || audioQueue.length === 0) return;

    isAudioPlaying = true;
    const currentItem = audioQueue.shift();

    setTimeout(() => {
        executeSpeech(currentItem.message, () => {
            isAudioPlaying = false;
            processAudioQueue();
        });
    }, currentItem.delaySeconds);
}

function executeSpeech(message, onComplete) {
    window.speechSynthesis.cancel();
    if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
    }

    // 💡 [핵심 안전장치] 혹시 전달되는 메시지에 '안내 말씀 드립니다'가 포함되어 있다면 무조건 강제 삭제
    let cleanMessage = message
        .replace(/안내\s*말씀\s*드립니다[\.!]?\s*/g, '')
        .trim();

    let refinedMessage = cleanMessage
        // 코트 번호 교정
        .replace(/1\s*번/g, '일 번')
        .replace(/2\s*번/g, '이 번')
        .replace(/3\s*번/g, '삼 번')
        .replace(/4\s*번/g, '사 번')
        .replace(/5\s*번/g, '오 번')
        .replace(/6\s*번/g, '육 번')
        .replace(/7\s*번/g, '칠 번')
        .replace(/8\s*번/g, '팔 번')
        .replace(/9\s*번/g, '구 번');

    // "회원님은"을 기준으로 앞의 이름 부분과 뒤의 입장 멘트를 깔끔하게 조합
    if (refinedMessage.includes('회원님은')) {
        let parts = refinedMessage.split('회원님은');
        let rawNames = parts[0].trim();
        
        // 각 이름의 글자 사이에 미세한 띄어쓰기를 주어 또렷하게 발음되도록 유도
        let spacedNames = rawNames.split(',').map(nameGroup => {
            return nameGroup.trim().split('').join(' '); 
        }).join(', ');

        refinedMessage = `${spacedNames} 회원님은${parts[1]}`;
    }

    const utterance = new SpeechSynthesisUtterance(refinedMessage);
    utterance.lang = 'ko-KR';
    
    utterance.rate = 0.93; 
    utterance.pitch = 1.0; 

    const voices = window.speechSynthesis.getVoices();
    const bestVoice = voices.find(v => v.lang === 'ko-KR' && (v.name.includes('Google') || v.name.includes('Natural'))) ||
                    voices.find(v => v.lang.includes('ko') && v.name.includes('Heami')) ||
                    voices.find(v => v.lang.includes('ko'));
                    
    if (bestVoice) {
        utterance.voice = bestVoice;
    }

    utterance.onend = () => {
        if (typeof onComplete === 'function') onComplete();
    };

    utterance.onerror = () => {
        if (typeof onComplete === 'function') onComplete();
    };

    window.speechSynthesis.speak(utterance);
}

if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
    };
}