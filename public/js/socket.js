// 중복 소켓 초기화 방지
const socket = window.socket || io();
window.socket = socket; 

// 💡 서버와 웹소켓 연결 성공
if (!socket.hasListeners('connect')) {
    socket.on('connect', () => {
        console.log("🟢 서버와 웹소켓 연결 성공 (ID:", socket.id, ")");
        
        const savedUser = localStorage.getItem("currentUser");
        if (savedUser) {
            try {
                const parsedUser = JSON.parse(savedUser);
                if (parsedUser.username) {
                    socket.emit('registerUserSession', parsedUser.username);
                    console.log(`👤 [자동 등록] 세션 유지 중인 유저(${parsedUser.username})를 소켓에 등록했습니다.`);
                }
            } catch (e) {
                console.error("세션 유저 파싱 에러:", e);
            }
        }
    });
}

// 📱 스마트폰 토스트 팝업 수신 및 렌더링
socket.off('toastAlert').on('toastAlert', (message) => {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.innerHTML = message;

    container.appendChild(toast);

    setTimeout(() => {
        if (toast && toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
    }, 10000);
});

socket.off('stateUpdated').on('stateUpdated', (data) => {
    if (data.config) CONFIG = data.config;
    courtsData = data.courtsData || [];
    gameQueue = data.gameQueue || [];
    nantaQueue = data.nantaQueue || [];
    notificationsList = data.notifications || [];
    if (typeof renderAll === 'function') {
        renderAll();
    }
});

// 서버가 보낸 경고/안내 메시지
socket.off('alertMessage').on('alertMessage', (msg) => {
    alert(msg);
});

// 1. 서비스 워커 등록
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
        console.log('서비스 워커 등록 성공:', reg.scope);
    }).catch((err) => {
        console.warn('서비스 워커 등록 실패:', err);
    });
}

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission !== 'granted') {
        Notification.requestPermission().then((permission) => {
            console.log('알림 권한 상태:', permission);
        });
    }
}

document.addEventListener('click', () => {
    if ('Notification' in window && Notification.permission === 'default') {
        requestNotificationPermission();
    }
}, { once: true });

// 3. 💡 입장 30초 경과 시 알림
socket.off('entryPopupAlert').on('entryPopupAlert', async (data) => {
    let myName = '';
    const savedUser = localStorage.getItem("currentUser");
    
    if (savedUser) {
        try {
            const parsed = JSON.parse(savedUser);
            myName = (parsed.name || parsed.username || '').split('/')[0].trim();
        } catch (e) {
            myName = savedUser.split('/')[0].trim();
        }
    }
    
    if (!myName) {
        myName = (localStorage.getItem("userName") || localStorage.getItem("username") || '').split('/')[0].trim();
    }

    if (myName && data.targetPlayers && data.targetPlayers.includes(myName)) {
        if ('vibrate' in navigator) {
            navigator.vibrate([500, 200, 500]);
        }

        if ('Notification' in window && Notification.permission === 'granted') {
            const title = `🏟️ [${data.courtNumber}번 ${data.matchType} 코트]`;
            const options = {
                body: '지금 코트로 입장해 주세요! (30초 제한)',
                icon: '/favicon.ico',
                badge: '/favicon.ico',
                tag: 'court-entry-alert',
                renotify: true
            };

            if ('serviceWorker' in navigator) {
                try {
                    const reg = await navigator.serviceWorker.ready;
                    reg.showNotification(title, options);
                } catch (e) {}
            } else {
                try {
                    new Notification(title, options);
                } catch (e) {}
            }
        }

        const popup = document.createElement('div');
        popup.innerHTML = `
            <div style="font-size: 20px; font-weight: 800; color: #4ade80; margin-bottom: 6px;">
                🏟️ [${data.courtNumber}번 ${data.matchType} 코트]
            </div>
            <div style="font-size: 16px; font-weight: 600; color: #ffffff;">
                지금 코트로 입장해 주세요!
            </div>
        `;

        popup.style.cssText = `
            position: fixed !important;
            top: 22% !important;
            left: 16px !important;
            right: 16px !important;
            max-width: 460px !important;
            margin: 0 auto !important;
            box-sizing: border-box !important;
            width: auto !important;
            background-color: rgba(15, 23, 42, 0.96) !important;
            border: 2px solid #22c55e !important;
            border-radius: 14px !important;
            padding: 22px 16px !important;
            text-align: center !important;
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6) !important;
            z-index: 999999 !important;
            pointer-events: none !important;
        `;

        document.body.appendChild(popup);

        setTimeout(() => {
            popup.remove();
        }, 5000);
    }
});

// =================================================================
// 💡 [핵심 복구] 서버가 보내주는 방 개설 확인 및 교차 방 개설 경고 리스너
// =================================================================
let isProcessingSlot = false;

socket.off('confirmFirstSlot').on('confirmFirstSlot', async ({ type, userId, user }) => {
    if (isProcessingSlot) return; // 중복 실행 원천 차단
    isProcessingSlot = true;

    try {
        const roomTypeName = type === 'game' ? '게임' : '난타';
        const isConfirmed = await confirm(`${roomTypeName} 대기 방을 개설하시겠습니까?`);
        if (isConfirmed) {
            socket.emit('forceCreateSlot', { type, userId, user });
        }
    } finally {
        setTimeout(() => { isProcessingSlot = false; }, 400); // 락 해제 딜레이
    }
});

socket.off('confirmCrossSlot').on('confirmCrossSlot', async ({ type, userId, user }) => {
    if (isProcessingSlot) return; // 중복 실행 원천 차단
    isProcessingSlot = true;

    try {
        const roomTypeName = type === 'game' ? '게임' : '난타';
        const oppositeTypeName = type === 'game' ? '난타' : '게임';
        
        // 💡 원하셨던 교차 방 개설 경고창 메시지 출력
        const isConfirmed = await confirm(`현재 ${oppositeTypeName} 대기 상태입니다. ${roomTypeName} 방을 개설하시면 기존 대기 상태에 영향을 줄 수 있습니다. 계속하시겠습니까?`);
        if (isConfirmed) {
            socket.emit('forceCreateSlot', { type, userId, user });
        }
    } finally {
        setTimeout(() => { isProcessingSlot = false; }, 400); // 락 해제 딜레이
    }
});

// =================================================================
// 💡 관리자 코트 강제 종료 공지
// =================================================================
if (typeof socket !== 'undefined') {
    let alertTimer = null;

    socket.off('courtClearedNotice').on('courtClearedNotice', (data) => {
        const banner = document.getElementById('court-alert-banner');
        const alertText = document.getElementById('court-alert-text');

        if (banner && alertText) {
            alertText.textContent = data.message;

            if (data.category === 'game') {
                banner.style.backgroundColor = '#2980b9';
            } else if (data.category === 'nanta') {
                banner.style.backgroundColor = '#e67e22';
            } else if (data.category === 'lesson') {
                banner.style.backgroundColor = '#8e44ad';
            } else {
                banner.style.backgroundColor = '#c0392b';
            }

            banner.style.display = 'block';

            if (alertTimer) {
                clearTimeout(alertTimer);
            }

            alertTimer = setTimeout(() => {
                banner.style.display = 'none';
            }, 4000);
        }
    });
}

// =================================================================
// 💡 난타 코트 종료 요청
// =================================================================
window.requestClearNantaCourt = async function(courtId, side) {
    const isConfirmed = await confirm("정말로 난타를 종료(퇴장)하시겠습니까?");
    if (isConfirmed) {
        socket.emit('clearNantaCourt', { courtId, side });
    }
};

// 강제 로그아웃 처리
if (typeof socket !== 'undefined' && socket) {
    socket.off('forceLogout').on('forceLogout', (data) => {
        const savedUser = localStorage.getItem("currentUser");
        let targetMatch = false;

        const targetUser = (data.username || '').split('/')[0].trim();

        if (savedUser) {
            try {
                const parsedUser = JSON.parse(savedUser);
                const localName = (parsedUser.name || parsedUser.username || parsedUser.id || '').split('/')[0].trim();
                const localPhone = (parsedUser.phone || '').trim();

                if (localName === targetUser || localPhone === targetUser || parsedUser.username === targetUser) {
                    targetMatch = true;
                }
            } catch (e) {
                const rawClean = savedUser.split('/')[0].trim();
                if (rawClean === targetUser) {
                    targetMatch = true;
                }
            }
        } else {
            targetMatch = true;
        }

        if (targetMatch) {
            console.warn('⚠️ [강제 로그아웃]', data.reason || '세션 만료');
            
            localStorage.removeItem("currentUser");
            localStorage.removeItem("username");
            localStorage.removeItem("userName");
            sessionStorage.clear();
            
            const alertText = data.message || '다른 기기 또는 브라우저에서 로그인되어 현재 연결이 종료되었습니다.';
            alert(alertText);
            
            window.location.reload(); 
        }
    });
}