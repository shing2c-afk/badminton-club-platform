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