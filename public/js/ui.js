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

    // 현재 로그인한 사용자 이름 가져오기
    const savedUser = localStorage.getItem("currentUser");
    let currentUserName = "";
    if (savedUser) {
        try {
            const u = JSON.parse(savedUser);
            currentUserName = (u.name || u.username || "").trim();
        } catch (e) {}
    }

    // 📌 [완전 해결] 기존 클래스 영향력을 무시하고 인라인 스타일로 완벽하게 동일한 줄 간격/폰트 강제 적용
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
            .map(p => `<div style="width: 100%; text-align: left; font-size: inherit; font-family: inherit; line-height: 1.5; margin-bottom: 4px;">${escapeHtml(p)}</div>`)
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
                            <!-- 📌 부모 컨테이너도 세로 정렬 및 간격 균일화 설정 -->
                            <div class="court-players" style="display: flex; flex-direction: column; align-items: flex-start; width: 100%; gap: 2px;">${formatPlayersToLines(court.players)}</div>
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
                 <div class="court-players" style="display: flex; flex-direction: column; align-items: flex-start; width: 100%; gap: 2px; margin-bottom:6px;">${formatPlayersToLines(court.sideA ? court.sideA.players : '')}</div>
                 ${sideABtn}`;

            const sideBContent = (court.sideB && court.sideB.isEmpty) ? 
                `<div class="nanta-empty-text">+ B반코트 (빈 코트)</div>` :
                `<div class="nanta-card-head">
                    <span class="nanta-label">B 반코트</span>
                    <span class="nanta-timer-badge">⏱️ ${formatTime(court.sideB ? court.sideB.remainingSeconds : 0)}</span>
                 </div>
                 <div class="court-players" style="display: flex; flex-direction: column; align-items: flex-start; width: 100%; gap: 2px; margin-bottom:6px;">${formatPlayersToLines(court.sideB ? court.sideB.players : '')}</div>
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

// 1. 대기열 렌더링 함수 (통합 메뉴 템플릿 포함)
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

    // 내가 이 게임 대기열 어디든 참여 중인지 확인
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
                if (isMe) {
                    // 내 퇴장 버튼: 활성화 (빨간색 계열)
                    playerCellsHtml += `<div class="player-cell"><span class="player-info">${escapeHtml(p)}</span><button class="btn-exit" onclick="exitGamePlayer('${slot.id}', ${i})">퇴장</button></div>`;
                } else {
                    // 타인의 퇴장 버튼: 비활성화 (회색 계열)
                    playerCellsHtml += `<div class="player-cell"><span class="player-info">${escapeHtml(p)}</span><button class="btn-exit" disabled style="background:#444; color:#888; opacity:0.6; cursor:not-allowed;">퇴장</button></div>`;
                }
            } else {
                // 빈자리 처리: 텍스트는 "게임참여"로 통일하되 활성화/비활성화 상태 구분
                if (amIInGameQueue) {
                    // 비활성화된 게임참여 -> 어두운 회색
                    playerCellsHtml += `<div class="player-cell" style="background:#2a2a2a; cursor:not-allowed;"><span class="empty-cell" style="color:#777;">게임참여</span></div>`;
                } else {
                    // 활성화된 게임참여 -> 밝은 텍스트 및 클릭 가능
                    playerCellsHtml += `<div class="player-cell" onclick="joinGameCell('${slot.id}', ${i})" style="cursor:pointer;"><span class="empty-cell" style="color:#fff; font-weight:500;">게임참여</span></div>`;
                }
            }
        }

        // 공통으로 사용할 유효 인원 및 본인 방 여부 체크 변수
        const validPlayersCount = getValidPlayers(slot.players).length;
        const isMySlotGame = slot.players && slot.players.some(p => p && currentUserName && p.includes(currentUserName));

        // 1. 코트 입장 버튼 활성/비활성화 판별 로직
        const isFullGame = (validPlayersCount === 4);
        let gameEnterBtnHtml = '';
        if (isFullGame && isMySlotGame) {
            // 4명 꽉 차고 내 방일 때: 초록색 활성화
            gameEnterBtnHtml = `<button class="btn-action btn-enter" onclick="enterGameCourt('${slot.id}')" style="background: #10b981; color: #fff; cursor: pointer; opacity: 1;">코트 입장</button>`;
        } else {
            // 조건 미달 또는 남의 방일 때: 회색 비활성화
            gameEnterBtnHtml = `<button class="btn-action btn-enter" disabled style="background: #2a2a2a; color: #777; cursor: not-allowed; opacity: 0.6;">코트 입장</button>`;
        }

        // 2. 게임 통합 버튼 활성/비활성화 판별 로직 (1~3명이고 내 방일 때만 활성화, 4명이면 비활성화)
        const isMergeableCount = (validPlayersCount > 0 && validPlayersCount < 4);
        let gameMergeBtnHtml = '';
        if (isMergeableCount && isMySlotGame) {
            gameMergeBtnHtml = `<button class="btn-action btn-merge" onclick="mergeGameSlot('${slot.id}')" style="background: #8b5cf6; color: #fff; cursor: pointer; opacity: 1;">게임 통합</button>`;
        } else {
            gameMergeBtnHtml = `<button class="btn-action btn-merge" disabled style="background: #2a2a2a; color: #777; cursor: not-allowed; opacity: 0.6;">게임 통합</button>`;
        }

        // 만약 현재 슬롯이 통합 메뉴를 열어둔 상태라면 리스트 HTML 생성 (상태 변수 연동)
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
                    const playersStr = getValidPlayers(targetSlot.players).join(", ");
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
                <div class="players-grid">${playerCellsHtml}</div>
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

// 2. 게임 통합 버튼 클릭 시 호출되는 함수 (상태값 토글 후 렌더링)
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

    // 합칠 수 있는 대상 슬롯이 있는지 우선 체크
    const targetSlots = gameQueue.filter(s => {
        if (s.id === slotId) return false;
        const targetValid = getValidPlayers(s.players);
        return (currentValidPlayers.length + targetValid.length === 4);
    });

    if (targetSlots.length === 0) {
        alert("⚠️ 현재 합쳤을 때 총원이 4명이 되는 다른 대기 방이 없습니다.");
        return;
    }

    // 이미 열려 있는 방을 다시 누르면 닫고, 다른 방이면 해당 방의 메뉴를 연다.
    if (activeMergeSlotId === slotId) {
        activeMergeSlotId = null;
    } else {
        activeMergeSlotId = slotId;
    }

    // 대기열 화면을 다시 그려서 메뉴를 안정적으로 표시/제거한다.
    renderGameQueue();
}

// 3. 실제 통합 실행 함수
function confirmAndExecuteMerge(mySlotId, targetSlotId, targetRank) {
    if (confirm(`[${targetRank}순위 방]과 통합하시겠습니까?\n(합쳐진 총 인원: 4명)`)) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('mergeSlot', { 
                mySlotId: mySlotId, 
                targetSlotId: targetSlotId 
            });
            activeMergeSlotId = null; // 통합 요청 후 메뉴 닫기
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

    // 내가 이 난타 대기열 어디든 참여 중인지 확인
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
                if (isMe) {
                    // 내 퇴장 버튼: 활성화 (빨간색 계열)
                    playerCellsHtml += `<div class="player-cell"><span class="player-info">${escapeHtml(p)}</span><button class="btn-exit" onclick="exitNantaPlayer('${slot.id}', ${i})">퇴장</button></div>`;
                } else {
                    // 타인의 퇴장 버튼: 비활성화 (회색 계열)
                    playerCellsHtml += `<div class="player-cell"><span class="player-info">${escapeHtml(p)}</span><button class="btn-exit" disabled style="background:#444; color:#888; opacity:0.6; cursor:not-allowed;">퇴장</button></div>`;
                }
            } else {
                // 빈자리 처리: 텍스트는 "난타참여"로 통일하되 활성화/비활성화 상태 구분
                if (amIInNantaQueue) {
                    // 비활성화된 난타참여 -> 어두운 회색
                    playerCellsHtml += `<div class="player-cell" style="background:#2a2a2a; cursor:not-allowed;"><span class="empty-cell" style="color:#777;">난타참여</span></div>`;
                } else {
                    // 활성화된 난타참여 -> 밝은 텍스트 및 클릭 가능
                    playerCellsHtml += `<div class="player-cell" onclick="joinNantaCell('${slot.id}', ${i})" style="cursor:pointer;"><span class="empty-cell" style="color:#fff; font-weight:500;">난타참여</span></div>`;
                }
            }
        }

        // 난타 코트 입장 버튼 활성/비활성화 판별 로직
        const validNantaCount = getValidPlayers(slot.players).length;
        const isFullNanta = (validNantaCount === 2);
        const isMySlotNanta = slot.players && slot.players.some(p => p && currentUserName && p.includes(currentUserName));

        let nantaEnterBtnHtml = '';
        if (isFullNanta && isMySlotNanta) {
            // 2명 꽉 차고 내 방일 때: 초록색 활성화
            nantaEnterBtnHtml = `<button class="btn-action btn-enter" onclick="enterNantaCourt('${slot.id}')" style="background: #10b981; color: #fff; cursor: pointer; opacity: 1;">코트 입장</button>`;
        } else {
            // 조건 미달 또는 남의 방일 때: 회색 비활성화
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
                <div class="players-grid">${playerCellsHtml}</div>
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

function joinGameCell(slotId, idx) {
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

    // 이름, 성별, 연령대, 급수 추출 (데이터 구조에 맞게 안전하게 가져오기)
    const name = (u.name || u.username || "").trim();
    const gender = (u.gender || "").trim();
    const age = (u.age || u.ageGroup || "").trim();
    const level = (u.level || u.grade || "").trim();

    if (!name) {
        alert("회원 이름 정보를 찾을 수 없습니다.");
        return;
    }

    // 요구하신 순서: 이름 / 성별 / 연령대 / 급수 (예: "김민수 / 남 / 40대 / A조")
    // 데이터가 없는 항목은 빈 값 대신 자연스럽게 처리되도록 조합합니다.
    const parts = [name, gender, age, level].filter(Boolean);
    const formattedPlayerInfo = parts.join("/");

    // 확인창 띄우기 (정보 타이핑 없이 참여 여부만 물어봄)
    if (confirm(`[${formattedPlayerInfo}]로 게임에 참여하시겠습니까?`)) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('joinPlayer', { type: 'game', slotId, index: idx, name: formattedPlayerInfo });
        }
    }
}

function joinNantaCell(slotId, idx) {
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

    // 요구하신 순서: 이름 / 성별 / 연령대 / 급수
    const parts = [name, gender, age, level].filter(Boolean);
    const formattedPlayerInfo = parts.join("/");

    if (confirm(`[${formattedPlayerInfo}]로 난타에 참여하시겠습니까?`)) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('joinPlayer', { type: 'nanta', slotId, index: idx, name: formattedPlayerInfo });
        }
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

function enterGameCourt(slotId) {
    const slot = gameQueue.find(s => s.id === slotId);
    if (!slot) return;

    // 💡 [추가] 로그인한 회원이 이 방에 참여 중인지 확인
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
    // ----------------------------------------------------

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

    if (confirm(`${assignedCourtNumber}번 코트로 입장하시겠습니까?`)) {
        if (typeof cancelVoiceAnnouncement === 'function') {
            cancelVoiceAnnouncement(assignedCourtNumber);
        }

        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('enterCourtFromSlot', { type: 'game', slotId });
        changeMainTab('court');
    }
}

function enterNantaCourt(slotId) {
    const slot = nantaQueue.find(s => s.id === slotId);
    if (!slot) return;

    // 💡 [추가] 로그인한 회원이 이 난타 방에 참여 중인지 확인
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
    // ----------------------------------------------------

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

    if (confirm(`난타 ${assignedCourtNumber}번 코트 (${sideText}반코트)로 입장하시겠습니까?`)) {
        if (typeof cancelVoiceAnnouncement === 'function') {
            cancelVoiceAnnouncement(assignedCourtNumber);
        }

        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('enterCourtFromSlot', { type: 'nanta', slotId });
        changeMainTab('court');
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