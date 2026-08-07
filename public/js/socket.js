const socket = io();

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