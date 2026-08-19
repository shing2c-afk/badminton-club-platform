const socket = io();
window.socket = socket; // 👈 전역으로 공유

// 💡 [추가] 서버와 웹소켓 연결이 맺어지자마자 로그인된 유저가 있다면 서버에 자동 등록
socket.on('connect', () => {
    console.log("🟢 서버와 웹소켓 연결 성공 (ID:", socket.id, ")");
    
    const savedUser = localStorage.getItem("currentUser");
    if (savedUser) {
        try {
            const parsedUser = JSON.parse(savedUser);
            if (parsedUser.username) {
                // ⚠️ 서버 코드와 이벤트명을 맞추기 위해 'registerUserSession'으로 수정했습니다.
                socket.emit('registerUserSession', parsedUser.username);
                console.log(`👤 [자동 등록] 세션 유지 중인 유저(${parsedUser.username})를 소켓에 등록했습니다.`);
            }
        } catch (e) {
            console.error("세션 유저 파싱 에러:", e);
        }
    }
});

// 소켓 실시간 이벤트 수신
socket.on('toastAlert', (msg) => {
    if (typeof showToast === 'function') {
        showToast(msg);
    }
});

socket.on('stateUpdated', (data) => {
    if (data.config) CONFIG = data.config;
    courtsData = data.courtsData || [];
    gameQueue = data.gameQueue || [];
    nantaQueue = data.nantaQueue || [];
    notificationsList = data.notifications || [];
    if (typeof renderAll === 'function') {
        renderAll();
    }
});

// 서버가 보낸 경고/안내 메시지를 받아서 팝업으로 띄워줌
socket.on('alertMessage', (msg) => {
    alert(msg);
});

// 💡 [신규 추가] 서버가 보낸 첫 방 개설 확인 요청을 받아 브라우저 Confirm 창 띄우기
socket.on('confirmFirstSlot', ({ type, userId, user }) => {
    const roomTypeName = type === 'game' ? '게임' : '난타';
    const isConfirmed = confirm(`${roomTypeName} 대기 방을 개설하시겠습니까?`);

    if (isConfirmed) {
        // 사용자가 '확인'을 누르면 서버로 최종 생성 요청 전송
        socket.emit('forceCreateSlot', { type, userId, user });
    }
});

// 서버가 보낸 교차 개설 확인 요청을 받아 브라우저 Confirm 창 띄우기
socket.on('confirmCrossSlot', ({ type, userId, user }) => {
    const roomTypeName = type === 'game' ? '게임' : '난타';
    const oppositeTypeName = type === 'game' ? '난타' : '게임';

    // 기존 대기 상태에 영향을 줄 수 있음을 안내하는 문구
    const isConfirmed = confirm(`현재 ${oppositeTypeName} 대기 상태입니다. ${roomTypeName} 방을 개설하시면 기존 대기 상태에 영향을 줄 수 있습니다. 계속하시겠습니까?`);

    if (isConfirmed) {
        // 사용자가 '확인'을 누르면 서버로 최종 개설 요청 전송
        socket.emit('forceCreateSlot', { type, userId, user });
    }
});

// =================================================================
// 💡 관리자가 코트를 강제 종료했을 때 브라우저(메인/TV)에 색상별 맞춤 팝업 띄우기
// =================================================================
if (typeof socket !== 'undefined') {
    let alertTimer = null;

    socket.on('courtClearedNotice', (data) => {
        const banner = document.getElementById('court-alert-banner');
        const alertText = document.getElementById('court-alert-text');

        if (banner && alertText) {
            // 서버에서 보낸 정확한 문구 세팅
            alertText.textContent = data.message;

            // 🎨 게임코트와 난타코트 팝업 배경 색상 다르게 분기 처리
            if (data.category === 'game') {
                banner.style.backgroundColor = '#2980b9'; // 🟦 게임코트: 진한 파란색 계열
            } else if (data.category === 'nanta') {
                banner.style.backgroundColor = '#e67e22'; // 🟧 난타코트: 진한 주황색 계열
            } else if (data.category === 'lesson') {
                banner.style.backgroundColor = '#8e44ad'; // 🟪 레슨코트: 진한 보라색 계열
            } else {
                banner.style.backgroundColor = '#c0392b'; // 기본 빨간색
            }

            // 팝업 화면에 표시
            banner.style.display = 'block';

            // 연속으로 뜰 때 타이머 초기화
            if (alertTimer) {
                clearTimeout(alertTimer);
            }

            // 4초 뒤에 팝업 자동으로 숨김
            alertTimer = setTimeout(() => {
                banner.style.display = 'none';
            }, 4000);
        }
    });
}
// =================================================================
// 💡 난타 코트 종료(퇴장) 요청 함수 (버튼 클릭 시 실행)
// =================================================================
window.requestClearNantaCourt = function(courtId, side) {
    if (confirm("정말로 난타를 종료(퇴장)하시겠습니까?")) {
        // 서버로 난타 코트 종료 이벤트 전송 (서버의 이벤트명인 'clearNantaCourt' 또는 'clearCourt'에 맞춤)
        // 만약 서버 이벤트명이 다를 경우 서버 소켓 라우터 코드에 맞춰 수정 가능합니다.
        socket.emit('clearNantaCourt', { courtId, side });
    }
};