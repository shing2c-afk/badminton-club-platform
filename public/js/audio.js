// public/js/audio.js

let audioQueue = [];
let isAudioPlaying = false;
let pendingAnnouncements = new Map(); // 코트별 30초 대기 타이머 관리 저장소
let currentUtterance = null; // 브라우저 가비지 컬렉터가 음성을 끊는 현상 방지

/**
 * 30초 대기 중 회원이 코트에 입장했을 때 예약을 취소하는 함수
 * @param {string|number} announcementId - 취소할 코트 번호 등의 ID
 */
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

    // 동일한 ID(코트)로 이미 대기 중인 타이머가 있다면 기존 타이머 초기화 (중복 예약 방지)
    if (announcementId && pendingAnnouncements.has(announcementId)) {
        clearTimeout(pendingAnnouncements.get(announcementId));
        pendingAnnouncements.delete(announcementId);
    }

    // 딜레이가 있는 경우 지정된 시간(초)만큼 대기한 후 큐에 등록
    if (delaySeconds > 0) {
        const timerId = setTimeout(() => {
            audioQueue.push({ message });
            if (announcementId) pendingAnnouncements.delete(announcementId);
            processAudioQueue();
        }, delaySeconds * 1000);

        if (announcementId) {
            pendingAnnouncements.set(announcementId, timerId);
        }
        return;
    }

    // 딜레이가 없는 즉시 재생인 경우 바로 큐에 등록
    audioQueue.push({ message });
    processAudioQueue();
}

function processAudioQueue() {
    console.log(`[Audio Debug] 현재 큐 상태:`, audioQueue.length, `개 대기 중 | 재생 중 여부:`, isAudioPlaying);

    // 현재 진행 중인 음성이 있거나 큐가 비어있으면 대기
    if (isAudioPlaying || audioQueue.length === 0) return;

    isAudioPlaying = true;
    const currentItem = audioQueue.shift();
    console.log(`[Audio Debug] 재생 시작:`, currentItem.message);

    executeSpeech(currentItem.message, () => {
        console.log(`[Audio Debug] 재생 완료, 0.4초 텀 대기 중...`);
        // 이전 방송이 완전히 끝난 후 0.4초의 여유(텀)를 두어 브라우저 엔진 초기화 및 겹침 방지
        setTimeout(() => {
            isAudioPlaying = false;
            processAudioQueue();
        }, 400);
    });
}

function executeSpeech(message, onComplete) {
    window.speechSynthesis.cancel(); // 큐에서 새로 재생을 시작할 때 안전하게 초기화
    if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
    }

    let cleanMessage = message
        .replace(/안내\s*말씀\s*드립니다[\.!]?\s*/g, '')
        .trim();

    let refinedMessage = cleanMessage
        .replace(/1\s*번/g, '일 번')
        .replace(/2\s*번/g, '이 번')
        .replace(/3\s*번/g, '삼 번')
        .replace(/4\s*번/g, '사 번')
        .replace(/5\s*번/g, '오 번')
        .replace(/6\s*번/g, '육 번')
        .replace(/7\s*번/g, '칠 번')
        .replace(/8\s*번/g, '팔 번')
        .replace(/9\s*번/g, '구 번');

    if (refinedMessage.includes('회원님은')) {
        let parts = refinedMessage.split('회원님은');
        let rawNames = parts[0].trim();
        
        let spacedNames = rawNames.split(',').map(nameGroup => {
            return nameGroup.trim().split('').join(' '); 
        }).join(', ');

        refinedMessage = `${spacedNames} 회원님은${parts[1]}`;
    }

    currentUtterance = new SpeechSynthesisUtterance(refinedMessage);
    currentUtterance.lang = 'ko-KR';
    currentUtterance.rate = 0.93; 
    currentUtterance.pitch = 1.0; 

    const voices = window.speechSynthesis.getVoices();
    const bestVoice = voices.find(v => v.lang === 'ko-KR' && (v.name.includes('Google') || v.name.includes('Natural'))) ||
                voices.find(v => v.lang.includes('ko') && v.name.includes('Heami')) ||
                voices.find(v => v.lang.includes('ko'));
                
    if (bestVoice) {
        currentUtterance.voice = bestVoice;
    }

    currentUtterance.onend = () => {
        currentUtterance = null;
        if (typeof onComplete === 'function') onComplete();
    };

    currentUtterance.onerror = () => {
        currentUtterance = null;
        if (typeof onComplete === 'function') onComplete();
    };

    window.speechSynthesis.speak(currentUtterance);
}

if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
    };
}