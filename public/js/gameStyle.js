// =========================================================================
// 🏷️ 회원 게임 성향 설정 및 대기방 조회 모듈 (태그 추가/수정은 아래 목록만 편집)
// =========================================================================
window.GAME_STYLE_TAGS = [
    '#잔소리보단_파이팅',
    '#실수해도_웃으면서',
    '#무한긍정_하이파이브',
    '#조용히_집중모드',
    '#빡겜·땀빼고싶어요',
    '#긴랠리·체력전환영',
    '#수비위주·안정지향',
    '#네트앞_전위요정',
    '#후위스매싱_담당',
    '#초심환영·천천히해요',
    '#한수배우고_싶어요',
    '#매너가_실력이다',
    '#오늘컨디션_최상'
];

window.clubGameStyles = window.clubGameStyles || {};
let selectedStyleTags = [];

function getStyleClubId() {
    return (typeof currentClubId !== 'undefined' && currentClubId)
        || window.currentClubId
        || new URLSearchParams(window.location.search).get('club')
        || 'unjeong';
}

function getStyleCurrentUser() {
    const clubId = getStyleClubId();
    const storageKey = (typeof getClubStorageKey === 'function') ? getClubStorageKey('currentUser') : `currentUser_${clubId}`;
    const raw = localStorage.getItem(storageKey) || localStorage.getItem('currentUser');
    if (!raw) return null;
    try {
        const user = JSON.parse(raw);
        const rawName = user.rawName || user.name || user.username || user.nickname || (typeof user === 'string' ? user : '');
        const cleanName = String(rawName).replace(/\(일일\)/g, '').replace(/님$/, '').trim();
        return cleanName ? { ...user, cleanName } : null;
    } catch (e) {
        return null;
    }
}

// 소켓 실시간 동기화 연결
function initGameStyleSocket() {
    const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
    if (!activeSocket) return;

    const clubId = getStyleClubId();
    activeSocket.emit('getGameStyles', { clubId });

    activeSocket.off('gameStylesUpdated').on('gameStylesUpdated', (payload) => {
        if (!payload || !payload.styles) return;
        const targetClub = payload.clubId || getStyleClubId();
        window.clubGameStyles[targetClub] = payload.styles;
        if (typeof renderGameQueue === 'function') {
            renderGameQueue();
        }
    });

    activeSocket.on('connect', () => {
        activeSocket.emit('getGameStyles', { clubId: getStyleClubId() });
    });
}

// 대기방 회원 칸에 붙을 말풍선 뱃지 HTML 반환
window.getPlayerStyleBadgeHtml = function(cleanMemberName) {
    const clubId = getStyleClubId();
    const stylesMap = window.clubGameStyles[clubId] || {};
    const styleData = stylesMap[cleanMemberName];
    if (!styleData) return '';
    const hasTags = Array.isArray(styleData.tags) && styleData.tags.length > 0;
    const hasMemo = styleData.memo && styleData.memo.trim() !== '';
    if (!hasTags && !hasMemo) return '';

    return `<span style="display:inline-flex; align-items:center; flex-shrink:0; margin-left:7px; padding:1px 6px; font-size:10.5px; background:rgba(245,158,11,0.16); border:1px solid rgba(245,158,11,0.45); color:#fbbf24; border-radius:9px; line-height:1.2;">💬</span>`;
};

// 1. 내 게임 성향 설정 모달 열기 (상단 회원명 터치 시)
window.openMyGameStyleModal = function() {
    const user = getStyleCurrentUser();
    if (!user || !user.cleanName) return;

    const modal = document.getElementById('my-game-style-modal');
    const tagContainer = document.getElementById('style-tag-selector');
    const memoInput = document.getElementById('style-memo-input');
    const titleEl = document.getElementById('my-style-modal-title');
    if (!modal || !tagContainer || !memoInput) return;

    const clubId = getStyleClubId();
    const existing = (window.clubGameStyles[clubId] && window.clubGameStyles[clubId][user.cleanName]) || { tags: [], memo: '' };
    selectedStyleTags = Array.isArray(existing.tags) ? [...existing.tags] : [];

    if (titleEl) titleEl.textContent = `${user.cleanName}님의 게임 성향`;
    memoInput.value = existing.memo || '';

    renderStyleTagChips();
    modal.style.display = 'flex';
};

window.closeMyGameStyleModal = function() {
    const modal = document.getElementById('my-game-style-modal');
    if (modal) modal.style.display = 'none';
};

function renderStyleTagChips() {
    const tagContainer = document.getElementById('style-tag-selector');
    if (!tagContainer) return;

    tagContainer.innerHTML = window.GAME_STYLE_TAGS.map((tag) => {
        const isSelected = selectedStyleTags.includes(tag);
        const bg = isSelected ? 'rgba(245, 158, 11, 0.22)' : '#1e222d';
        const border = isSelected ? '1px solid #f59e0b' : '1px solid #333a48';
        const color = isSelected ? '#fbbf24' : '#cbd5e1';
        const weight = isSelected ? '700' : '500';
        return `<button type="button" onclick="toggleGameStyleTag('${tag}')" style="padding:7px 11px; border-radius:18px; background:${bg}; border:${border}; color:${color}; font-size:12px; font-weight:${weight}; cursor:pointer; transition:all 0.15s;">${tag}</button>`;
    }).join('');
}

window.toggleGameStyleTag = function(tag) {
    const idx = selectedStyleTags.indexOf(tag);
    if (idx > -1) {
        selectedStyleTags.splice(idx, 1);
    } else {
        if (selectedStyleTags.length >= 3) {
            alert('게임 성향 태그는 최대 3개까지 선택할 수 있습니다.');
            return;
        }
        selectedStyleTags.push(tag);
    }
    renderStyleTagChips();
};

window.saveMyGameStyle = function() {
    const user = getStyleCurrentUser();
    if (!user || !user.cleanName) return;

    const memoInput = document.getElementById('style-memo-input');
    const memoVal = memoInput ? memoInput.value.trim() : '';
    const clubId = getStyleClubId();
    const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;

    // 화면 즉시 반영
    window.clubGameStyles[clubId] = window.clubGameStyles[clubId] || {};
    if (selectedStyleTags.length === 0 && memoVal === '') {
        delete window.clubGameStyles[clubId][user.cleanName];
    } else {
        window.clubGameStyles[clubId][user.cleanName] = { tags: [...selectedStyleTags], memo: memoVal };
    }
    if (typeof renderGameQueue === 'function') renderGameQueue();

    if (activeSocket && activeSocket.connected) {
        activeSocket.emit('saveGameStyle', {
            clubId,
            memberName: user.cleanName,
            tags: selectedStyleTags,
            memo: memoVal
        });
    }
    closeMyGameStyleModal();
};

window.resetMyGameStyle = function() {
    selectedStyleTags = [];
    const memoInput = document.getElementById('style-memo-input');
    if (memoInput) memoInput.value = '';
    renderStyleTagChips();
};

// 2. 대기방 회원 성향 조회 팝업 열기 (다른 곳 터치 시 자동 닫힘)
window.openPlayerStyleView = function(memberName) {
    const clubId = getStyleClubId();
    const stylesMap = window.clubGameStyles[clubId] || {};
    const styleData = stylesMap[memberName];
    if (!styleData) return;

    const hasTags = Array.isArray(styleData.tags) && styleData.tags.length > 0;
    const hasMemo = styleData.memo && styleData.memo.trim() !== '';
    if (!hasTags && !hasMemo) return;

    const modal = document.getElementById('game-style-view-modal');
    const nameEl = document.getElementById('view-style-member-name');
    const tagsEl = document.getElementById('view-style-tags');
    const memoEl = document.getElementById('view-style-memo');
    if (!modal || !nameEl || !tagsEl || !memoEl) return;

    nameEl.textContent = `${memberName}님의 게임 성향`;
    tagsEl.innerHTML = hasTags
        ? styleData.tags.map(t => `<span style="display:inline-block; padding:5px 10px; border-radius:16px; background:rgba(245,158,11,0.18); border:1px solid rgba(245,158,11,0.5); color:#fbbf24; font-size:12px; font-weight:700;">${t}</span>`).join('')
        : '';
    tagsEl.style.display = hasTags ? 'flex' : 'none';

    if (hasMemo) {
        memoEl.textContent = `"${styleData.memo}"`;
        memoEl.style.display = 'block';
    } else {
        memoEl.style.display = 'none';
    }

    modal.style.display = 'flex';
};

window.closePlayerStyleView = function() {
    const modal = document.getElementById('game-style-view-modal');
    if (modal) modal.style.display = 'none';
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(initGameStyleSocket, 300));
} else {
    setTimeout(initGameStyleSocket, 300);
}