let CONFIG = { ENTRY_TIMEOUT_SEC: 180, NANTA_COURT_LIMIT_SEC: 900, ENABLE_ALERT: true };
let courtsData = [];
let gameQueue = [];
let nantaQueue = [];
let notificationsList = [];

let currentUser = null;

let activeMergeSlotId = null;

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

async function accessAdmin() {
    const inputPw = await prompt('🔐 관리자 비밀번호를 입력해 주세요:');
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

    const savedUser = localStorage.getItem("currentUser");
    let currentUserName = "";
    if (savedUser) {
        try {
            const u = JSON.parse(savedUser);
            currentUserName = (u.name || u.username || "").trim();
        } catch (e) {}
    }

    function formatPlayersToLines(playersInput) {
        if (!playersInput) return '';
        let pArray = [];

        if (Array.isArray(playersInput)) {
            pArray = playersInput;
        } else if (typeof playersInput === 'string') {
            pArray = playersInput.split(',').map(item => item.trim());
        }

        return pArray
            .filter(p => p && p.length > 0)
            .map(p => {
                let normalizedStr = p;
                if (p.includes('/')) {
                    normalizedStr = p.split('/').map(part => part.trim()).join(' / ');
                }
                return `<div>${escapeHtml(normalizedStr)}</div>`;
            })
            .join('');
    }

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
                let isUserOnThisCourt = false;
                if (court.players) {
                    if (Array.isArray(court.players)) {
                        isUserOnThisCourt = court.players.some(p => p && currentUserName && p.includes(currentUserName));
                    } else if (typeof court.players === 'string') {
                        isUserOnThisCourt = currentUserName && court.players.includes(currentUserName);
                    }
                }

                let gameActionBtns = '';
                if (isUserOnThisCourt) {
                    gameActionBtns = `
                        <button class="btn-court-ctrl btn-again" onclick="clickAgain(${court.id})">한 게임 더</button>
                        <button class="btn-court-ctrl btn-end" onclick="clickEnd(${court.id})">게임 종료</button>
                    `;
                } else {
                    gameActionBtns = `
                        <button class="btn-court-ctrl btn-again" disabled style="background: #2a2a2a; color: #777; cursor: not-allowed; opacity: 0.6;">한 게임 더</button>
                        <button class="btn-court-ctrl btn-end" disabled style="background: #2a2a2a; color: #777; cursor: not-allowed; opacity: 0.6;">게임 종료</button>
                    `;
                }

                html = `
                    <div class="court-row">
                        <div class="court-head-info">
                            <span class="court-num">${court.id}번 코트</span>
                            <span class="type-badge badge-game">게임 코트</span>
                        </div>
                        <div class="court-body-game">
                            <div class="court-players">${formatPlayersToLines(court.players)}</div>
                            <div class="court-timer-off"></div>
                            <div>
                                ${gameActionBtns}
                            </div>
                        </div>
                    </div>`;
            }
        } 
        else if(court.type === 'nanta') {
            let isUserOnSideA = false;
            if (court.sideA && court.sideA.players) {
                if (Array.isArray(court.sideA.players)) {
                    isUserOnSideA = court.sideA.players.some(p => p && currentUserName && p.includes(currentUserName));
                } else if (typeof court.sideA.players === 'string') {
                    isUserOnSideA = currentUserName && court.sideA.players.includes(currentUserName);
                }
            }

            let isUserOnSideB = false;
            if (court.sideB && court.sideB.players) {
                if (Array.isArray(court.sideB.players)) {
                    isUserOnSideB = court.sideB.players.some(p => p && currentUserName && p.includes(currentUserName));
                } else if (typeof court.sideB.players === 'string') {
                    isUserOnSideB = currentUserName && court.sideB.players.includes(currentUserName);
                }
            }

            const sideABtn = isUserOnSideA ? 
                `<button class="btn-court-ctrl btn-end" onclick="clickNantaEnd(${court.id}, 'sideA')">난타 종료</button>` :
                `<button class="btn-court-ctrl btn-end" disabled style="background: #2a2a2a; color: #777; cursor: not-allowed; opacity: 0.6;">난타 종료</button>`;

            const sideBBtn = isUserOnSideB ? 
                `<button class="btn-court-ctrl btn-end" onclick="clickNantaEnd(${court.id}, 'sideB')">난타 종료</button>` :
                `<button class="btn-court-ctrl btn-end" disabled style="background: #2a2a2a; color: #777; cursor: not-allowed; opacity: 0.6;">난타 종료</button>`;

            const sideAContent = (court.sideA && court.sideA.isEmpty) ? 
                `<div class="nanta-empty-text">+ A반코트 (빈 코트)</div>` :
                `<div class="nanta-card-head">
                    <span class="nanta-label">A 반코트</span>
                    <span class="nanta-timer-badge">⏱️ ${formatTime(court.sideA ? court.sideA.remainingSeconds : 0)}</span>
                 </div>
                 <div class="court-players">${formatPlayersToLines(court.sideA ? court.sideA.players : '')}</div>
                 ${sideABtn}`;

            const sideBContent = (court.sideB && court.sideB.isEmpty) ? 
                `<div class="nanta-empty-text">+ B반코트 (빈 코트)</div>` :
                `<div class="nanta-card-head">
                    <span class="nanta-label">B 반코트</span>
                    <span class="nanta-timer-badge">⏱️ ${formatTime(court.sideB ? court.sideB.remainingSeconds : 0)}</span>
                 </div>
                 <div class="court-players">${formatPlayersToLines(court.sideB ? court.sideB.players : '')}</div>
                 ${sideBBtn}`;

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

    const savedUser = localStorage.getItem("currentUser");
    let currentUserName = "";
    if (savedUser) {
        try {
            const u = JSON.parse(savedUser);
            currentUserName = (u.name || u.username || "").trim();
        } catch (e) {}
    }

    function formatPlayerText(playerStr) {
        if (!playerStr) return '';
        if (playerStr.includes('/')) {
            return playerStr.split('/').map(part => part.trim()).join(' / ');
        }
        return playerStr;
    }

    const amIInGameQueue = gameQueue.some(slot => 
        slot.players && slot.players.some(p => p && currentUserName && p.includes(currentUserName))
    );

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
                const isMe = currentUserName && currentUserName !== '' && p.includes(currentUserName);
                const formattedPlayer = formatPlayerText(p);
                if (isMe) {
                    playerCellsHtml += `<div class="player-cell"><span class="player-info">${escapeHtml(formattedPlayer)}</span><button class="btn-exit" onclick="exitGamePlayer('${slot.id}', ${i})">퇴장</button></div>`;
                } else {
                    playerCellsHtml += `<div class="player-cell"><span class="player-info">${escapeHtml(formattedPlayer)}</span><button class="btn-exit" disabled style="background:#444; color:#888; opacity:0.6; cursor:not-allowed;">퇴장</button></div>`;
                }
            } else {
                if (amIInGameQueue) {
                    playerCellsHtml += `<div class="player-cell" style="background:#2a2a2a; cursor:not-allowed;"><span class="empty-cell" style="color:#777;">게임참여</span></div>`;
                } else {
                    playerCellsHtml += `<div class="player-cell" onclick="joinGameCell('${slot.id}', ${i})" style="cursor:pointer;"><span class="empty-cell" style="color:#fff; font-weight:500;">게임참여</span></div>`;
                }
            }
        }

        const validPlayersCount = getValidPlayers(slot.players).length;
        const isMySlotGame = slot.players && slot.players.some(p => p && currentUserName && p.includes(currentUserName));

        const isFullGame = (validPlayersCount === 4);
        let gameEnterBtnHtml = '';
        if (isFullGame && isMySlotGame) {
            gameEnterBtnHtml = `<button class="btn-action btn-enter" onclick="enterGameCourt('${slot.id}')" style="background: #10b981; color: #fff; cursor: pointer; opacity: 1;">코트 입장</button>`;
        } else {
            gameEnterBtnHtml = `<button class="btn-action btn-enter" disabled style="background: #2a2a2a; color: #777; cursor: not-allowed; opacity: 0.6;">코트 입장</button>`;
        }

        const isMergeableCount = (validPlayersCount > 0 && validPlayersCount < 4);
        let gameMergeBtnHtml = '';
        if (isMergeableCount && isMySlotGame) {
            gameMergeBtnHtml = `<button class="btn-action btn-merge" onclick="mergeGameSlot('${slot.id}')" style="background: #8b5cf6; color: #fff; cursor: pointer; opacity: 1;">게임 통합</button>`;
        } else {
            gameMergeBtnHtml = `<button class="btn-action btn-merge" disabled style="background: #2a2a2a; color: #777; cursor: not-allowed; opacity: 0.6;">게임 통합</button>`;
        }

        let mergeMenuHtml = '';
        if (activeMergeSlotId === slot.id) {
            const targetSlots = gameQueue.filter(s => {
                if (s.id === slot.id) return false;
                const targetValid = getValidPlayers(s.players);
                return (validPlayersCount + targetValid.length === 4);
            });

            let listHtml = '';
            if (targetSlots.length === 0) {
                listHtml = `<div style="color: #888; font-size: 12px; padding: 6px 0;">합칠 수 있는 대기 방이 없습니다.</div>`;
            } else {
                targetSlots.forEach((targetSlot) => {
                    const targetRank = gameQueue.findIndex(s => s.id === targetSlot.id) + 1;
                    const rawPlayersList = getValidPlayers(targetSlot.players).map(p => formatPlayerText(p));
                    const playersStr = rawPlayersList.join(", ");
                    listHtml += `
                        <div class="merge-option-item" onclick="confirmAndExecuteMerge('${slot.id}', '${targetSlot.id}', ${targetRank})" style="padding: 10px 12px; margin-bottom: 6px; background: #1e1e2f; border: 1px solid #7c3aed; border-radius: 6px; cursor: pointer;">
                            <div style="font-weight: bold; color: #a78bfa; font-size: 13px;">📌 ${targetRank}순위 방과 통합</div>
                            <div style="color: #cbd5e1; font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">멤버: ${escapeHtml(playersStr)}</div>
                        </div>
                    `;
                });
            }

            mergeMenuHtml = `
                <div class="merge-dropdown-menu" style="margin-top: 10px; padding: 12px; background: #111118; border: 1px solid #4c1d95; border-radius: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <span style="font-size: 13px; font-weight: bold; color: #fff;">🔄 합칠 대기 방을 선택하세요</span>
                        <span onclick="activeMergeSlotId = null; renderGameQueue();" style="cursor: pointer; color: #888; font-size: 14px; padding: 0 4px;">✕</span>
                    </div>
                    ${listHtml}
                </div>
            `;
        }

        const timerText = slot.remainingSeconds !== null ? `⏱️ 입장제한 ${formatTime(slot.remainingSeconds)}` : '대기중';
        const timerClass = slot.remainingSeconds !== null ? '' : 'idle';

        const html = `
            <div class="slot-card game-slot">
                <div class="slot-header">
                    <span class="rank-badge">${rank}순위</span>
                    <span class="timer-badge ${timerClass}">${timerText}</span>
                </div>
                <div class="players-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px;">${playerCellsHtml}</div>
                <div class="slot-footer">
                    ${gameEnterBtnHtml}
                    ${gameMergeBtnHtml}
                </div>
                ${mergeMenuHtml}
            </div>
        `;
        container.insertAdjacentHTML('beforeend', html);
    });
}

function mergeGameSlot(slotId) {
    const savedUser = localStorage.getItem("currentUser");
    let currentUserName = "";
    if (savedUser) {
        try {
            const u = JSON.parse(savedUser);
            currentUserName = (u.name || u.username || "").trim();
        } catch (e) {}
    }

    const currentSlot = gameQueue.find(s => s.id === slotId);
    if (!currentSlot) return;

    const currentValidPlayers = getValidPlayers(currentSlot.players);
    const isMySlot = currentSlot.players.some(p => p && currentUserName && p.includes(currentUserName));
    if (!isMySlot || currentValidPlayers.length === 0 || currentValidPlayers.length >= 4) return;

    const targetSlots = gameQueue.filter(s => {
        if (s.id === slotId) return false;
        const targetValid = getValidPlayers(s.players);
        return (currentValidPlayers.length + targetValid.length === 4);
    });

    if (targetSlots.length === 0) {
        alert("⚠️ 현재 합쳤을 때 총원이 4명이 되는 다른 대기 방이 없습니다.");
        return;
    }

    if (activeMergeSlotId === slotId) {
        activeMergeSlotId = null;
    } else {
        activeMergeSlotId = slotId;
    }

    renderGameQueue();
}

async function confirmAndExecuteMerge(mySlotId, targetSlotId, targetRank) {
    const confirmed = await confirm(`[${targetRank}순위 방]과 통합하시겠습니까?\n(합쳐진 총 인원: 4명)`);
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('mergeSlot', { 
                mySlotId: mySlotId, 
                targetSlotId: targetSlotId 
            });
            activeMergeSlotId = null;
        }
    }
}

function renderNantaQueue() {
    const container = document.getElementById('nanta-slot-list');
    if (!container) return;
    container.innerHTML = '';

    const savedUser = localStorage.getItem("currentUser");
    let currentUserName = "";
    if (savedUser) {
        try {
            const u = JSON.parse(savedUser);
            currentUserName = (u.name || u.username || "").trim();
        } catch (e) {}
    }

    function formatNantaPlayerText(playerStr) {
        if (!playerStr) return '';
        if (playerStr.includes('/')) {
            return playerStr.split('/').map(part => part.trim()).join(' / ');
        }
        return playerStr;
    }

    const amIInNantaQueue = nantaQueue.some(slot => 
        slot.players && slot.players.some(p => p && currentUserName && p.includes(currentUserName))
    );

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
                const isMe = currentUserName && currentUserName !== '' && p.includes(currentUserName);
                const formattedNantaPlayer = formatNantaPlayerText(p);
                if (isMe) {
                    playerCellsHtml += `<div class="player-cell"><span class="player-info">${escapeHtml(formattedNantaPlayer)}</span><button class="btn-exit" onclick="exitNantaPlayer('${slot.id}', ${i})">퇴장</button></div>`;
                } else {
                    playerCellsHtml += `<div class="player-cell"><span class="player-info">${escapeHtml(formattedNantaPlayer)}</span><button class="btn-exit" disabled style="background:#444; color:#888; opacity:0.6; cursor:not-allowed;">퇴장</button></div>`;
                }
            } else {
                if (amIInNantaQueue) {
                    playerCellsHtml += `<div class="player-cell" style="background:#2a2a2a; cursor:not-allowed;"><span class="empty-cell" style="color:#777;">난타참여</span></div>`;
                } else {
                    playerCellsHtml += `<div class="player-cell" onclick="joinNantaCell('${slot.id}', ${i})" style="cursor:pointer;"><span class="empty-cell" style="color:#fff; font-weight:500;">난타참여</span></div>`;
                }
            }
        }

        const validNantaCount = getValidPlayers(slot.players).length;
        const isFullNanta = (validNantaCount === 2);
        const isMySlotNanta = slot.players && slot.players.some(p => p && currentUserName && p.includes(currentUserName));

        let nantaEnterBtnHtml = '';
        if (isFullNanta && isMySlotNanta) {
            nantaEnterBtnHtml = `<button class="btn-action btn-enter" onclick="enterNantaCourt('${slot.id}')" style="background: #10b981; color: #fff; cursor: pointer; opacity: 1;">코트 입장</button>`;
        } else {
            nantaEnterBtnHtml = `<button class="btn-action btn-enter" disabled style="background: #2a2a2a; color: #777; cursor: not-allowed; opacity: 0.6;">코트 입장</button>`;
        }

        const timerText = slot.remainingSeconds !== null ? `⏱️ 입장제한 ${formatTime(slot.remainingSeconds)}` : '대기중';
        const timerClass = slot.remainingSeconds !== null ? '' : 'idle';

        const html = `
            <div class="slot-card nanta-slot">
                <div class="slot-header">
                    <span class="rank-badge" style="color:#f97316;">${rank}순위</span>
                    <span class="timer-badge ${timerClass}">${timerText}</span>
                </div>
                <div class="players-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px;">${playerCellsHtml}</div>
                <div class="slot-footer">
                    ${nantaEnterBtnHtml}
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

async function joinGameCell(slotId, idx) {
    const savedUser = localStorage.getItem("currentUser");
    if (!savedUser) {
        alert("로그인 정보가 없습니다. 다시 로그인해 주세요.");
        return;
    }

    let u;
    try {
        u = JSON.parse(savedUser);
    } catch (e) {
        alert("사용자 정보를 불러오는 중 오류가 발생했습니다.");
        return;
    }

    const name = (u.name || u.username || "").trim();
    const gender = (u.gender || "").trim();
    const age = (u.age || u.ageGroup || "").trim();
    const level = (u.level || u.grade || "").trim();

    if (!name) {
        alert("회원 이름 정보를 찾을 수 없습니다.");
        return;
    }

    const parts = [name, gender, age, level].filter(Boolean);
    const formattedPlayerInfo = parts.join("/");

    const confirmed = await confirm(`[${formattedPlayerInfo}]로 게임에 참여하시겠습니까?`);
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('joinPlayer', { type: 'game', slotId, index: idx, name: formattedPlayerInfo });
        }
    }
}

async function joinNantaCell(slotId, idx) {
    const savedUser = localStorage.getItem("currentUser");
    if (!savedUser) {
        alert("로그인 정보가 없습니다. 다시 로그인해 주세요.");
        return;
    }

    let u;
    try {
        u = JSON.parse(savedUser);
    } catch (e) {
        alert("사용자 정보를 불러오는 중 오류가 발생했습니다.");
        return;
    }

    const name = (u.name || u.username || "").trim();
    const gender = (u.gender || "").trim();
    const age = (u.age || u.ageGroup || "").trim();
    const level = (u.level || u.grade || "").trim();

    if (!name) {
        alert("회원 이름 정보를 찾을 수 없습니다.");
        return;
    }

    const parts = [name, gender, age, level].filter(Boolean);
    const formattedPlayerInfo = parts.join("/");

    const confirmed = await confirm(`[${formattedPlayerInfo}]로 난타에 참여하시겠습니까?`);
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('joinPlayer', { type: 'nanta', slotId, index: idx, name: formattedPlayerInfo });
        }
    }
}

async function exitGamePlayer(slotId, idx) {
    const confirmed = await confirm('해당 회원을 정말 퇴장 처리하시겠습니까?');
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('exitPlayer', { type: 'game', slotId, index: idx });
    }
}

async function exitNantaPlayer(slotId, idx) {
    const confirmed = await confirm('해당 회원을 정말 퇴장 처리하시겠습니까?');
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('exitPlayer', { type: 'nanta', slotId, index: idx });
    }
}

async function enterGameCourt(slotId) {
    const slot = gameQueue.find(s => s.id === slotId);
    if (!slot) return;

    const savedUser = localStorage.getItem("currentUser");
    let currentUserName = "";
    if (savedUser) {
        try {
            const u = JSON.parse(savedUser);
            currentUserName = (u.name || u.username || "").trim();
        } catch (e) {}
    }

    const isMySlot = slot.players && slot.players.some(p => p && currentUserName && p.includes(currentUserName));
    if (!isMySlot) {
        alert('⚠️ 해당 게임 방에 참여 중인 회원만 코트에 입장할 수 있습니다.');
        return;
    }

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

    const emptyGameCourts = (typeof courtsData !== 'undefined') ? courtsData.filter(c => c.type === 'game' && c.isEmpty) : [];
    const courtIndex = allowedSlots.findIndex(s => s.id === slotId);
    const assignedCourtNumber = (courtIndex !== -1 && emptyGameCourts[courtIndex]) ? emptyGameCourts[courtIndex].id : 1;

    const confirmed = await confirm(`${assignedCourtNumber}번 코트로 입장하시겠습니까?`);
    if (confirmed) {
        if (typeof cancelVoiceAnnouncement === 'function') {
            cancelVoiceAnnouncement(assignedCourtNumber);
        }

        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('enterCourtFromSlot', { type: 'game', slotId });
        changeMainTab('court');
    }
}

async function enterNantaCourt(slotId) {
    const slot = nantaQueue.find(s => s.id === slotId);
    if (!slot) return;

    const savedUser = localStorage.getItem("currentUser");
    let currentUserName = "";
    if (savedUser) {
        try {
            const u = JSON.parse(savedUser);
            currentUserName = (u.name || u.username || "").trim();
        } catch (e) {}
    }

    const isMySlot = slot.players && slot.players.some(p => p && currentUserName && p.includes(currentUserName));
    if (!isMySlot) {
        alert('⚠️ 해당 난타 방에 참여 중인 회원만 코트에 입장할 수 있습니다.');
        return;
    }

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

    const emptyNantaCourts = (typeof courtsData !== 'undefined') ? courtsData.filter(c => c.type === 'nanta' && ((c.sideA && c.sideA.isEmpty) || (c.sideB && c.sideB.isEmpty))) : [];
    const courtIndex = allowedSlots.findIndex(s => s.id === slotId);
    
    let assignedCourtNumber = 6;
    let sideText = 'A';
    
    if (courtIndex !== -1 && emptyNantaCourts[courtIndex]) {
        const targetCourt = emptyNantaCourts[courtIndex];
        assignedCourtNumber = targetCourt.id;
        if (targetCourt.sideA && targetCourt.sideA.isEmpty) {
            sideText = 'A';
        } else {
            sideText = 'B';
        }
    }

    const confirmed = await confirm(`난타 ${assignedCourtNumber}번 코트 (${sideText}반코트)로 입장하시겠습니까?`);
    if (confirmed) {
        if (typeof cancelVoiceAnnouncement === 'function') {
            cancelVoiceAnnouncement(assignedCourtNumber);
        }

        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('enterCourtFromSlot', { type: 'nanta', slotId });
        changeMainTab('court');
    }
}

async function clickAgain(courtId) {
    const confirmed = await confirm('동일한 멤버로 한 게임 더 진행하시겠습니까? (대기열 최후순위로 재등록됩니다)');
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('extendGameCourt', { courtId: courtId });
        switchTab('game');
    }
}

async function clickEnd(courtId) {
    const confirmed = await confirm('게임을 종료하고 코트를 비우시겠습니까?');
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('endGameCourt', { courtId: courtId });
    }
}

async function clickNantaEnd(courtId, side) {
    const confirmed = await confirm('난타를 종료하고 퇴장하시겠습니까?');
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('endNantaCourt', { courtId, side });
        } else {
            alert("서버와 연결 상태를 확인해주세요.");
        }
    }
}

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
        headerUserEl.textContent = `${user.name}님`;
        
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket && user.username) {
            activeSocket.emit('registerUserSession', user.username);
        }
    } else {
        headerUserEl.textContent = "로그인 필요";
    }
}

async function handleLogout() {
    const confirmed = await confirm("로그아웃 하시겠습니까?");
    if (confirmed) {
        const rawUser = localStorage.getItem("currentUser");

        if (rawUser) {
            try {
                let userData = rawUser;
                try {
                    const parsed = JSON.parse(rawUser);
                    if (parsed) userData = parsed;
                } catch (e) {}

                await fetch('/api/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user: userData })
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
        localStorage.removeItem("username");
        sessionStorage.clear();
        location.reload(); 
    }
}

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