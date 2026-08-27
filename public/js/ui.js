let CONFIG = { ENTRY_TIMEOUT_SEC: 180, NANTA_COURT_LIMIT_SEC: 900, ENABLE_ALERT: true };
let courtsData = [];
let gameQueue = [];
let nantaQueue = [];
let notificationsList = [];

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function showToast(msg) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.innerText = msg;
    container.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 3500);
}

function renderAll() {
    renderCourts();
    renderGameQueue();
    renderNantaQueue();
    updateAvailableCourtCounts();
    renderNotifications();
}

function renderNotifications() {
    const notiCountEl = document.getElementById('noti-count');
    if (notiCountEl) notiCountEl.innerText = notificationsList.length;
    
    const container = document.getElementById('noti-list');
    if (!container) return;
    
    if (notificationsList.length === 0) {
        container.innerHTML = `<div style="text-align:center; color:#6b7280; font-size:12px; padding:20px 0;">새로운 알림이 없습니다.</div>`;
        return;
    }

    container.innerHTML = '';
    notificationsList.forEach(n => {
        const html = `
            <div class="noti-item">
                <div>${escapeHtml(n.message)}</div>
                <div class="noti-time">${escapeHtml(n.time)}</div>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', html);
    });
}

function openNotiModal() { 
    const modal = document.getElementById('noti-modal');
    if (modal) modal.style.display = 'flex'; 
}
function closeNotiModal() { 
    const modal = document.getElementById('noti-modal');
    if (modal) modal.style.display = 'none'; 
}

function accessAdmin() {
    const inputPw = prompt('🔐 관리자 비밀번호를 입력해 주세요:');
    if (inputPw === null) return;

    const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
    if (!activeSocket) {
        alert("소켓 연결이 원활하지 않습니다.");
        return;
    }

    activeSocket.emit('verifyAdminPassword', inputPw.trim(), (response) => {
        if (response.success) {
            window.location.href = '/admin.html';
        } else {
            alert('❌ 비밀번호가 일치하지 않습니다.');
        }
    });
}

function formatTime(sec) {
    if (sec <= 0 || sec === null || sec === undefined) return "00:00";
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getValidPlayers(arr) {
    return arr.filter(p => p && p.trim() !== '');
}

function getAvailableGameCourtsCount() {
    return courtsData.filter(c => c.type === 'game' && c.isEmpty).length;
}

function getAvailableNantaCourtsCount() {
    let count = 0;
    courtsData.forEach(c => {
        if (c.type === 'nanta') {
            if (c.sideA && c.sideA.isEmpty) count += 1;
            if (c.sideB && c.sideB.isEmpty) count += 1;
        }
    });
    return count;
}

function formatCourtPlayers(playersStr) {
    if (!playersStr) return '';
    const plist = playersStr.split(',').map(p => p.trim());
    if (plist.length >= 4) {
        return `${escapeHtml(plist[0])}, ${escapeHtml(plist[1])}<br>${escapeHtml(plist[2])}, ${escapeHtml(plist[3])}`;
    }
    return escapeHtml(playersStr);
}

function renderCourts() {
    const courtList = document.getElementById('court-status-list');
    if (!courtList) return;
    courtList.innerHTML = '';

    courtsData.forEach(court => {
        let html = '';
        if(court.type === 'game') {
            if(court.isEmpty) {
                html = `
                    <div class="court-row">
                        <div class="court-head-info">
                            <span class="court-num">${court.id}번 코트</span>
                            <span class="type-badge badge-game">게임 코트</span>
                        </div>
                        <div class="empty-court-box">✨ 빈 코트 (입장 대기 가능)</div>
                    </div>`;
            } else {
                html = `
                    <div class="court-row">
                        <div class="court-head-info">
                            <span class="court-num">${court.id}번 코트</span>
                            <span class="type-badge badge-game">게임 코트</span>
                        </div>
                        <div class="court-body-game">
                            <div class="court-players">${formatCourtPlayers(court.players)}</div>
                            <div class="court-timer-off"></div>
                            <div>
                                <button class="btn-court-ctrl btn-again" onclick="clickAgain(${court.id})">한 게임 더</button>
                                <button class="btn-court-ctrl btn-end" onclick="clickEnd(${court.id})">게임 종료</button>
                            </div>
                        </div>
                    </div>`;
            }
        } 
        else if(court.type === 'nanta') {
            const sideAContent = (court.sideA && court.sideA.isEmpty) ? 
                `<div class="nanta-empty-text">+ A반코트 (빈 코트)</div>` :
                `<div class="nanta-card-head">
                    <span class="nanta-label">A 반코트</span>
                    <span class="nanta-timer-badge">⏱️ ${formatTime(court.sideA ? court.sideA.remainingSeconds : 0)}</span>
                 </div>
                 <div class="court-players" style="margin-bottom:6px;">${court.sideA ? escapeHtml(court.sideA.players) : ''}</div>
                 <button class="btn-court-ctrl btn-end" onclick="clickNantaEnd(${court.id}, 'sideA')">난타 종료</button>`;

            const sideBContent = (court.sideB && court.sideB.isEmpty) ? 
                `<div class="nanta-empty-text">+ B반코트 (빈 코트)</div>` :
                `<div class="nanta-card-head">
                    <span class="nanta-label">B 반코트</span>
                    <span class="nanta-timer-badge">⏱️ ${formatTime(court.sideB ? court.sideB.remainingSeconds : 0)}</span>
                 </div>
                 <div class="court-players" style="margin-bottom:6px;">${court.sideB ? escapeHtml(court.sideB.players) : ''}</div>
                 <button class="btn-court-ctrl btn-end" onclick="clickNantaEnd(${court.id}, 'sideB')">난타 종료</button>`;

            html = `
                <div class="court-row">
                    <div class="court-head-info">
                        <span class="court-num">${court.id}번 코트</span>
                        <span class="type-badge badge-nanta">난타 코트</span>
                    </div>
                    <div class="nanta-sub-grid">
                        <div class="nanta-card">${sideAContent}</div>
                        <div class="nanta-card">${sideBContent}</div>
                    </div>
                </div>`;
        } 
        else if(court.type === 'lesson') {
            html = `
                <div class="court-row">
                    <div class="court-head-info">
                        <span class="court-num">${court.id}번 코트</span>
                        <span class="type-badge badge-lesson">레슨 코트</span>
                    </div>
                    <div style="background:#1f2937; padding:10px; border-radius:6px; text-align:center; color:#c084fc; font-size:12px;">
                        ${escapeHtml(court.players || '코치 전용 레슨 코트')}
                    </div>
                </div>`;
        }
        courtList.insertAdjacentHTML('beforeend', html);
    });
}

function renderGameQueue() {
    const container = document.getElementById('game-slot-list');
    if (!container) return;
    container.innerHTML = '';

    if (gameQueue.length === 0) {
        container.innerHTML = `<div class="empty-queue-msg">현재 대기 중인 게임 방이 없습니다.</div>`;
        return;
    }

    gameQueue.forEach((slot, idx) => {
        const rank = idx + 1;
        let playerCellsHtml = '';

        for (let i = 0; i < 4; i++) {
            const p = slot.players[i];
            if (p && p.trim() !== '') {
                playerCellsHtml += `<div class="player-cell"><span class="player-info">${escapeHtml(p)}</span><button class="btn-exit" onclick="exitGamePlayer('${slot.id}', ${i})">퇴장</button></div>`;
            } else {
                playerCellsHtml += `<div class="player-cell" onclick="joinGameCell('${slot.id}', ${i})"><span class="empty-cell">+ 입장하기</span></div>`;
            }
        }

        const timerText = slot.remainingSeconds !== null ? `⏱️ 입장제한 ${formatTime(slot.remainingSeconds)}` : '대기중';
        const timerClass = slot.remainingSeconds !== null ? '' : 'idle';

        const html = `
            <div class="slot-card game-slot">
                <div class="slot-header">
                    <span class="rank-badge">${rank}순위</span>
                    <span class="timer-badge ${timerClass}">${timerText}</span>
                </div>
                <div class="players-grid">${playerCellsHtml}</div>
                <div class="slot-footer">
                    <button class="btn-action btn-enter" onclick="enterGameCourt('${slot.id}')">코트 입장</button>
                    <button class="btn-action btn-merge" onclick="mergeGameSlot('${slot.id}')">게임 통합</button>
                </div>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', html);
    });
}

function renderNantaQueue() {
    const container = document.getElementById('nanta-slot-list');
    if (!container) return;
    container.innerHTML = '';

    if (nantaQueue.length === 0) {
        container.innerHTML = `<div class="empty-queue-msg">현재 대기 중인 난타 방이 없습니다.</div>`;
        return;
    }

    nantaQueue.forEach((slot, idx) => {
        const rank = idx + 1;
        let playerCellsHtml = '';

        for (let i = 0; i < 2; i++) {
            const p = slot.players[i];
            if (p && p.trim() !== '') {
                playerCellsHtml += `<div class="player-cell"><span class="player-info">${escapeHtml(p)}</span><button class="btn-exit" onclick="exitNantaPlayer('${slot.id}', ${i})">퇴장</button></div>`;
            } else {
                playerCellsHtml += `<div class="player-cell" onclick="joinNantaCell('${slot.id}', ${i})"><span class="empty-cell">+ 입장하기</span></div>`;
            }
        }

        const timerText = slot.remainingSeconds !== null ? `⏱️ 입장제한 ${formatTime(slot.remainingSeconds)}` : '대기중';
        const timerClass = slot.remainingSeconds !== null ? '' : 'idle';

        const html = `
            <div class="slot-card nanta-slot">
                <div class="slot-header">
                    <span class="rank-badge" style="color:#f97316;">${rank}순위</span>
                    <span class="timer-badge ${timerClass}">${timerText}</span>
                </div>
                <div class="players-grid">${playerCellsHtml}</div>
                <div class="slot-footer">
                    <button class="btn-action btn-enter" onclick="enterNantaCourt('${slot.id}')">코트 입장</button>
                </div>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', html);
    });
}

function updateAvailableCourtCounts() {
    const gameAvail = document.getElementById('game-available-count');
    const nantaAvail = document.getElementById('nanta-available-count');
    if (gameAvail) gameAvail.innerText = getAvailableGameCourtsCount();
    if (nantaAvail) nantaAvail.innerText = getAvailableNantaCourtsCount();
}

function createNewGameSlot() {
    const savedUser = localStorage.getItem("currentUser");
    if (!savedUser) {
        alert("로그인 정보가 없습니다. 다시 로그인해 주세요.");
        return;
    }
    const user = JSON.parse(savedUser);
    const userInfo = `${user.name || ''} / ${user.gender || ''} / ${user.ageGroup || ''} / ${user.grade || ''}`;

    const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
    if (!activeSocket) {
        alert("소켓 연결이 원활하지 않습니다. 페이지를 새로고침 해보세요.");
        return;
    }

    activeSocket.emit('createSlot', { type: 'game', userId: user.id, user: userInfo });
}

function createNewNantaSlot() {
    const savedUser = localStorage.getItem("currentUser");
    if (!savedUser) {
        alert("로그인 정보가 없습니다. 다시 로그인해 주세요.");
        return;
    }
    const user = JSON.parse(savedUser);
    const userInfo = `${user.name || ''} / ${user.gender || ''} / ${user.ageGroup || ''} / ${user.grade || ''}`;

    const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
    if (!activeSocket) {
        alert("소켓 연결이 원활하지 않습니다. 페이지를 새로고침 해보세요.");
        return;
    }

    activeSocket.emit('createSlot', { type: 'nanta', userId: user.id, user: userInfo });
}

function joinGameCell(slotId, idx) {
    const name = prompt('참여할 회원의 [급수/연령/성별/이름]을 입력하세요:');
    if (name && name.trim() !== '') {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('joinPlayer', { type: 'game', slotId, index: idx, name: name.trim() });
    }
}

function joinNantaCell(slotId, idx) {
    const name = prompt('참여할 회원의 [급수/연령/성별/이름]을 입력하세요:');
    if (name && name.trim() !== '') {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('joinPlayer', { type: 'nanta', slotId, index: idx, name: name.trim() });
    }
}

function exitGamePlayer(slotId, idx) {
    if (confirm('해당 회원을 정말 퇴장 처리하시겠습니까?')) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('exitPlayer', { type: 'game', slotId, index: idx });
    }
}

function exitNantaPlayer(slotId, idx) {
    if (confirm('해당 회원을 정말 퇴장 처리하시겠습니까?')) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('exitPlayer', { type: 'nanta', slotId, index: idx });
    }
}

function mergeGameSlot(slotId) {
    const myIndex = gameQueue.findIndex(s => s.id === slotId);
    if (myIndex === -1) return;

    const myPlayers = getValidPlayers(gameQueue[myIndex].players);
    if (myPlayers.length >= 4) {
        alert('현재 방은 이미 4명이 채워져 있어 통합할 수 없습니다.');
        return;
    }

    let candidates = [];
    gameQueue.forEach((targetSlot, targetIdx) => {
        if (targetIdx === myIndex) return;
        const targetPlayers = getValidPlayers(targetSlot.players);
        if (targetPlayers.length > 0 && (myPlayers.length + targetPlayers.length) <= 4) {
            candidates.push({
                targetSlot: targetSlot,
                rank: targetIdx + 1,
                count: targetPlayers.length,
                playersText: targetPlayers.join(', ')
            });
        }
    });

    if (candidates.length === 0) {
        alert('통합할 수 있는 다른 대기 방이 없습니다 (합쳐서 4명 이하).');
        return;
    }

    let promptMsg = `🤝 [게임통합] 합칠 대기 방 번호를 입력하세요:\n\n`;
    candidates.forEach((c, idx) => {
        promptMsg += `${idx + 1}. [${c.rank}순위 방] - ${c.count}명 (${c.playersText})\n`;
    });

    const choice = prompt(promptMsg);
    if (!choice) return;

    const choiceNum = parseInt(choice.trim(), 10);
    if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= candidates.length) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('mergeSlot', {
                mySlotId: slotId,
                targetSlotId: candidates[choiceNum - 1].targetSlot.id
            });
        }
    }
}

function enterGameCourt(slotId) {
    const slot = gameQueue.find(s => s.id === slotId);
    if (!slot) return;

    const validPlayers = getValidPlayers(slot.players);
    if (validPlayers.length < 4) {
        alert('⚠️ 4명이 모두 채워져야 코트에 입장할 수 있습니다.');
        return;
    }

    const availableCourtsCount = getAvailableGameCourtsCount();
    if (availableCourtsCount <= 0) {
        alert('⚠️ 현재 빈 게임 코트가 없습니다.');
        return;
    }

    const readySlots = gameQueue.filter(s => getValidPlayers(s.players).length === 4);
    const allowedSlots = readySlots.slice(0, availableCourtsCount);
    const isAllowed = allowedSlots.some(s => s.id === slotId);

    if (!isAllowed) {
        alert(`⚠️ 현재 빈 코트가 ${availableCourtsCount}개뿐이므로, 앞 순서의 완성팀이 우선 입장 대상입니다.`);
        return;
    }

    if (confirm('코트로 입장하시겠습니까?')) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('enterCourtFromSlot', { type: 'game', slotId });
        changeMainTab('court'); // switchTab을 changeMainTab으로 수정
    }
}

function enterNantaCourt(slotId) {
    const slot = nantaQueue.find(s => s.id === slotId);
    if (!slot) return;

    const validPlayers = getValidPlayers(slot.players);
    if (validPlayers.length < 2) {
        alert('⚠️ 2명이 모두 채워져야 난타 코트에 입장할 수 있습니다.');
        return;
    }

    const availableCourtsCount = getAvailableNantaCourtsCount();
    if (availableCourtsCount <= 0) {
        alert('⚠️ 현재 빈 난타 코트가 없습니다.');
        return;
    }

    const readySlots = nantaQueue.filter(s => getValidPlayers(s.players).length === 2);
    const allowedSlots = readySlots.slice(0, availableCourtsCount);
    const isAllowed = allowedSlots.some(s => s.id === slotId);

    if (!isAllowed) {
        alert(`⚠️ 현재 빈 난타 코트가 ${availableCourtsCount}개뿐이므로, 앞 순서의 완성팀이 우선 입장 대상입니다.`);
        return;
    }

    if (confirm('난타 코트로 입장하시겠습니까?')) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('enterCourtFromSlot', { type: 'nanta', slotId });
        changeMainTab('court'); // switchTab을 changeMainTab으로 수정
    }
}

function clickAgain(courtId) {
    if (confirm('동일한 멤버로 한 게임 더 진행하시겠습니까? (대기열 최후순위로 재등록됩니다)')) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('extendGameCourt', { courtId: courtId });
        switchTab('game');
    }
}

function clickEnd(courtId) {
    if (confirm('게임을 종료하고 코트를 비우시겠습니까?')) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('endGameCourt', { courtId: courtId });
    }
}

function clickNantaEnd(courtId, side) {
    if (confirm('난타를 종료하고 퇴장하시겠습니까?')) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('endNantaCourt', { courtId, side });
        } else {
            alert("서버와 연결 상태를 확인해주세요.");
        }
    }
}

// 핵심 탭 전환 함수 (전역 등록)
window.switchTab = function(tabName) {
    const tabGame = document.getElementById('tab-game');
    const tabNanta = document.getElementById('tab-nanta');
    const tabCourt = document.getElementById('tab-court');

    const secGame = document.getElementById('section-game');
    const secNanta = document.getElementById('section-nanta');
    const secCourt = document.getElementById('section-court');

    if (tabGame) tabGame.classList.remove('active');
    if (tabNanta) tabNanta.classList.remove('active');
    if (tabCourt) tabCourt.classList.remove('active');

    if (secGame) secGame.style.display = 'none';
    if (secNanta) secNanta.style.display = 'none';
    if (secCourt) secCourt.style.display = 'none';

    if (tabName === 'game') {
        if (tabGame) tabGame.classList.add('active');
        if (secGame) secGame.style.display = 'block';
    } else if (tabName === 'nanta') {
        if (tabNanta) tabNanta.classList.add('active');
        if (secNanta) secNanta.style.display = 'block';
    } else if (tabName === 'court') {
        if (tabCourt) tabCourt.classList.add('active');
        if (secCourt) secCourt.style.display = 'block';
    }
}

function handleHome() {
    switchTab('game');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function applyUserProfile() {
    const userStr = localStorage.getItem("currentUser");
    const headerUserEl = document.getElementById("user-display-name"); 
    
    if (!headerUserEl) return;

    if (userStr) {
        const user = JSON.parse(userStr);
        headerUserEl.textContent = `${user.name}님 (${user.gender} / ${user.ageGroup} / ${user.grade})`;
        
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket && user.username) {
            activeSocket.emit('registerUserSession', user.username);
        }
    } else {
        headerUserEl.textContent = "로그인 필요";
    }
}

async function handleLogout() {
    if (confirm("로그아웃 하시겠습니까?")) {
        const rawUser = localStorage.getItem("currentUser");

        if (rawUser) {
            try {
                let username = rawUser;
                try {
                    const parsed = JSON.parse(rawUser);
                    if (parsed && parsed.username) username = parsed.username;
                } catch (e) {}

                await fetch('/api/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username })
                });
            } catch (err) {
                console.error("❌ 로그아웃 서버 통신 에러:", err);
            }
        }

        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.disconnect();
        }

        localStorage.removeItem("currentUser");
        location.reload(); 
    }
}

// 1. 고유한 이름의 메인 탭 전환 함수 (충돌 방지)
function changeMainTab(tabName) {
    console.log(`[메인 탭 전환] ${tabName} 실행됨`);
    
    const tabGame = document.getElementById('tab-game');
    const tabNanta = document.getElementById('tab-nanta');
    const tabCourt = document.getElementById('tab-court');

    const secGame = document.getElementById('section-game');
    const secNanta = document.getElementById('section-nanta');
    const secCourt = document.getElementById('section-court');

    if (tabGame) tabGame.classList.remove('active');
    if (tabNanta) tabNanta.classList.remove('active');
    if (tabCourt) tabCourt.classList.remove('active');

    if (secGame) secGame.style.display = 'none';
    if (secNanta) secNanta.style.display = 'none';
    if (secCourt) secCourt.style.display = 'none';

    if (tabName === 'game') {
        if (tabGame) tabGame.classList.add('active');
        if (secGame) secGame.style.display = 'block';
    } else if (tabName === 'nanta') {
        if (tabNanta) tabNanta.classList.add('active');
        if (secNanta) secNanta.style.display = 'block';
    } else if (tabName === 'court') {
        if (tabCourt) tabCourt.classList.add('active');
        if (secCourt) secCourt.style.display = 'block';
    }
}
window.changeMainTab = changeMainTab;

// 2. 전역 클릭 이벤트 위임 (어떤 상황에서도 탭 클릭을 완벽하게 캐치)
document.addEventListener('click', (event) => {
    const targetTab = event.target.closest('.tab-btn');
    if (!targetTab) return;

    if (targetTab.id === 'tab-game') {
        changeMainTab('game');
    } else if (targetTab.id === 'tab-nanta') {
        changeMainTab('nanta');
    } else if (targetTab.id === 'tab-court') {
        changeMainTab('court');
    }
});