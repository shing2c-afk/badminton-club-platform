const socket = io();
window.socket = socket; // 👈 전역으로 공유

// 소켓 실시간 이벤트 수신
socket.on('toastAlert', (msg) => {
    showToast(msg);
});

socket.on('stateUpdated', (data) => {
    if (data.config) CONFIG = data.config;
    courtsData = data.courtsData || [];
    gameQueue = data.gameQueue || [];
    nantaQueue = data.nantaQueue || [];
    notificationsList = data.notifications || [];
    renderAll();
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
            // 서버에서 보낸 정확한 문구 세팅 (예: "[관리자 알림] 1번 게임코트는...")
            alertText.textContent = data.message;

            // 🎨 게임코트와 난타코트 팝업 배경 색상 다르게 분기 처리
            if (data.category === 'game') {
                banner.style.backgroundColor = '#2980b9'; // 🟦 게임코트 삭제 시: 진한 파란색 계열
            } else if (data.category === 'nanta') {
                banner.style.backgroundColor = '#e67e22'; // 🟧 난타코트 삭제 시: 진한 주황색 계열
            } else if (data.category === 'lesson') {
                banner.style.backgroundColor = '#8e44ad'; // 🟪 레슨코트 삭제 시: 진한 보라색 계열
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