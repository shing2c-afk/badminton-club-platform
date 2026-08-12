const socket = io();
window.socket = socket; // 👈 이 줄을 추가하여 전역으로 공유합니다!

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