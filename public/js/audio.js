// public/js/audio.js

function playVoiceAnnouncement(message) {
    if (!('speechSynthesis' in window)) {
        console.warn('이 브라우저는 음성 합성을 지원하지 않는 브라우저입니다.');
        return;
    }

    window.speechSynthesis.cancel();

    let refinedMessage = message
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

    // 💡 [핵심] "회원님은" 바로 앞의 이름 부분에서 글자들 사이에 미세한 틈(띄어쓰기)을 줌
    // 예: "홍길동, 김철수 회원님은" -> "홍 길 동,  김 철 수,  회원님은" 형태로 변환되어 또렷하게 발음됨
    if (refinedMessage.includes('회원님은')) {
        // 이름 파트만 추출해서 글자 사이에 공백 추가
        let parts = refinedMessage.split('회원님은');
        let namePart = parts[0].replace(/안내 말씀 드립니다\.\s*/, '').trim();
        
        // 쉼표 단위로 나누고 각 글자 사이에 공백을 넣어줌
        let spacedNames = namePart.split(',').map(nameGroup => {
            return nameGroup.trim().split('').join(' '); // 글자마다 띄어쓰기 삽입 (예: 홍길동 -> 홍 길 동)
        }).join(', ');

        refinedMessage = `안내 말씀 드립니다. ${spacedNames}, 회원님은${parts[1]}`;
    }

    const utterance = new SpeechSynthesisUtterance(refinedMessage);
    utterance.lang = 'ko-KR';
    
    // 전체 속도는 0.93 정도로 유지하여 여유를 줌
    utterance.rate = 0.93; 
    utterance.pitch = 1.0; 

    // 고품질 구글/네츄럴 음성 우선 선택
    const voices = window.speechSynthesis.getVoices();
    const bestVoice = voices.find(v => v.lang === 'ko-KR' && (v.name.includes('Google') || v.name.includes('Natural'))) ||
                      voices.find(v => v.lang.includes('ko') && v.name.includes('Heami')) ||
                      voices.find(v => v.lang.includes('ko'));
                      
    if (bestVoice) {
        utterance.voice = bestVoice;
    }

    window.speechSynthesis.speak(utterance);
}

if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
    };
}