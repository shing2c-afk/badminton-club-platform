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

// 📱 스마트폰 토스트 팝업 수신 및 렌더링
socket.on('toastAlert', (message) => {
    // 1. 알림 컨테이너가 없으면 동적으로 생성
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    // 2. 토스트 요소 생성 (style.css의 널찍해진 .toast-msg 스타일 적용)
    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.innerHTML = message;

    // 3. 화면 상단에 띄우기
    container.appendChild(toast);

    // 4. 애니메이션 종료 시점(10초 뒤)에 화면에서 자동 제거
    setTimeout(() => {
        if (toast && toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
    }, 10000);
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

// 1. 서비스 워커 등록 (모바일 OS 알림 띄우기 위한 필수 선행 작업)
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
        console.log('서비스 워커 등록 성공:', reg.scope);
    }).catch((err) => {
        console.warn('서비스 워커 등록 실패 (HTTPS 환경인지 확인 필요):', err);
    });
}

// 2. 알림 권한 요청 함수 (화면 터치/로그인 등의 이벤트에서 호출 권장)
function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission !== 'granted') {
        Notification.requestPermission().then((permission) => {
            console.log('알림 권한 상태:', permission);
        });
    }
}

// 페이지 클릭 1회 시 자연스럽게 알림 권한 팝업 유도 (모바일 정책 통과용)
document.addEventListener('click', () => {
    if ('Notification' in window && Notification.permission === 'default') {
        requestNotificationPermission();
    }
}, { once: true });

// 3. 💡 입장 30초 경과 시: 모바일 상단 OS 배너 + 진동 + 인앱 팝업 동시 실행
socket.on('entryPopupAlert', async (data) => {
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

        // 📳 진동 실행 (안드로이드)
        if ('vibrate' in navigator) {
            navigator.vibrate([500, 200, 500]);
        }

        // 📱 스마트폰 상단 OS 시스템 배너 알림 (모바일 표준 방식)
        if ('Notification' in window && Notification.permission === 'granted') {
            const title = `🏟️ [${data.courtNumber}번 ${data.matchType} 코트]`;
            const options = {
                body: '지금 코트로 입장해 주세요! (30초 제한)',
                icon: '/favicon.ico',
                badge: '/favicon.ico',
                tag: 'court-entry-alert',
                renotify: true
            };

            // 모바일: 서비스 워커를 통해 시스템 배너 호출
            if ('serviceWorker' in navigator) {
                try {
                    const reg = await navigator.serviceWorker.ready;
                    reg.showNotification(title, options);
                } catch (e) {
                    console.warn('서비스 워커 배너 알림 실패:', e);
                }
            } else {
                // PC 등 일반 데스크톱 브라우저 대비 폴백
                try {
                    new Notification(title, options);
                } catch (e) {}
            }
        }

        // 🖥️ 브라우저 화면 내 와이드 팝업 (포그라운드 상태용)
        const popup = document.createElement('div');
        popup.innerHTML = `
            <div style="font-size: 20px; font-weight: 800; color: #4ade80; margin-bottom: 6px; letter-spacing: -0.3px;">
                🏟️ [${data.courtNumber}번 ${data.matchType} 코트]
            </div>
            <div style="font-size: 16px; font-weight: 600; color: #ffffff; letter-spacing: -0.2px;">
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

// 💡 [신규 추가] 서버가 보낸 첫 방 개설 확인 요청을 받아 브라우저 Confirm 창 띄우기
socket.on('confirmFirstSlot', ({ type, userId, user }) => {
    const roomTypeName = type === 'game' ? '게임' : '난타';
    const isConfirmed = confirm(`${roomTypeName} 대기 방을 개설하시겠습니까?`);

    if (isConfirmed) {
        socket.emit('forceCreateSlot', { type, userId, user });
    }
});

// 서버가 보낸 교차 개설 확인 요청을 받아 브라우저 Confirm 창 띄우기
socket.on('confirmCrossSlot', ({ type, userId, user }) => {
    const roomTypeName = type === 'game' ? '게임' : '난타';
    const oppositeTypeName = type === 'game' ? '난타' : '게임';

    const isConfirmed = confirm(`현재 ${oppositeTypeName} 대기 상태입니다. ${roomTypeName} 방을 개설하시면 기존 대기 상태에 영향을 줄 수 있습니다. 계속하시겠습니까?`);

    if (isConfirmed) {
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
// 💡 난타 코트 종료(퇴장) 요청 함수 (버튼 클릭 시 실행)
// =================================================================
window.requestClearNantaCourt = function(courtId, side) {
    if (confirm("정말로 난타를 종료(퇴장)하시겠습니까?")) {
        socket.emit('clearNantaCourt', { courtId, side });
    }
};

// 서버로부터 강제 로그아웃 신호를 받았을 때 (중복 로그인 차단 및 세션 만료 공용)
if (typeof socket !== 'undefined' && socket) {
    socket.on('forceLogout', (data) => {
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
            // 로컬스토리지에 정보가 없다면 안전하게 대상 일치로 간주
            targetMatch = true;
        }

        if (targetMatch) {
            console.warn('⚠️ [강제 로그아웃]', data.reason || '세션 만료');
            
            // 1. 세션 및 로컬 저장소 완전 초기화
            localStorage.removeItem("currentUser");
            localStorage.removeItem("username");
            localStorage.removeItem("userName");
            sessionStorage.clear();
            
            // 2. 사유에 따른 맞춤 안내 (중복 로그인 안내 또는 기본 세션 만료 안내)
            const alertText = data.message || '다른 기기 또는 브라우저에서 로그인되어 현재 연결이 종료되었습니다.';
            alert(alertText);
            
            // 3. 페이지 새로고침하여 로그인 화면으로 리셋
            window.location.reload(); 
        }
    });
}