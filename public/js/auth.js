// 🔑 현재 접속한 구장별 스토리지 키 생성 헬퍼
// 🏢 [멀티테넌트 수정] 주소창 URL(?club=)을 무조건 1순위로 확인하여 탭 간 키 혼선 차단
function getClubStorageKey(baseKey) {
  const urlClub = new URLSearchParams(window.location.search).get('club');
  const clubId = urlClub
                 || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                 || localStorage.getItem('preferredClubId')
                 || 'unjeong';
  return `${baseKey}_${clubId}`;
}

document.addEventListener("DOMContentLoaded", () => {
  const introOverlay = document.getElementById("auth-intro-overlay");
  const loginOverlay = document.getElementById("auth-login-overlay");
  const mainApp = document.getElementById("main-app");

  // 폼 및 입력 요소
  const memberLoginForm = document.getElementById("memberLoginForm");
  const guestLoginForm = document.getElementById("guestLoginForm");
  const authMsg = document.getElementById("auth-msg");

  const memberNameInput = document.getElementById('memberName');
  const guestNameInput = document.getElementById('guestName');

  // 이름 입력 필드 한글 최적화
  [memberNameInput, guestNameInput].forEach(input => {
    if (input) {
      input.setAttribute('lang', 'ko');
      input.setAttribute('inputmode', 'text');
      input.addEventListener('focus', () => {
        input.setAttribute('lang', 'ko');
      });
    }
  });

  // =================================================================
  // 🏢 [멀티 테넌트] 1. 전역 클럽 데이터 및 모달 제어 함수 (최상단 상시 활성화)
  // =================================================================
  window.availableClubs = [];

  // 서버에서 최신 클럽 목록 조회
  window.loadClubsData = async function() {
    if (window.availableClubs && window.availableClubs.length > 0) {
      return window.availableClubs;
    }
    try {
      const res = await fetch('/api/clubs');
      const data = await res.json();
      if (data.success && Array.isArray(data.clubs)) {
        window.availableClubs = data.clubs;
      }
    } catch (e) {
      console.error("클럽 목록 로드 실패:", e);
    }
    return window.availableClubs || [];
  };

  // 모달 카드 렌더링
  function renderClubCards(clubs) {
    const container = document.getElementById('clubListContainer');
    if (!container) return;

    // 🏢 [멀티테넌트 수정] 현재 실제 접속 중인 구장을 기준으로 '선택됨' 표시
    const activeClubId = new URLSearchParams(window.location.search).get('club')
                         || window.currentClubId
                         || localStorage.getItem('preferredClubId');
    if (!clubs || clubs.length === 0) {
      container.innerHTML = '<div class="club-loading">운영 중인 클럽이 없습니다.</div>';
      return;
    }

    container.innerHTML = clubs.map(club => {
      const isCurrent = club.id === activeClubId;
      return `
        <div class="club-item-card ${isCurrent ? 'active' : ''}" onclick="selectClub('${club.id}')">
          <div class="club-item-info">
            <div class="club-item-name">${club.name}</div>
            <div class="club-item-courts">총 ${club.courtCount}개 코트 운영 중</div>
          </div>
          ${isCurrent ? '<span class="club-item-badge">선택됨</span>' : ''}
        </div>
      `;
    }).join('');
  }

  // 모달 열기 (로그인 후 [클럽 변경] 클릭 시에도 항상 동작)
  window.openClubModal = async function(allowClose = true) {
    const modal = document.getElementById('clubSelectModal');
    const closeBtn = document.getElementById('closeClubModalBtn');
    if (!modal) return;

    modal.style.display = 'flex';
    if (closeBtn) closeBtn.style.display = allowClose ? 'block' : 'none';

    const clubs = await window.loadClubsData();
    renderClubCards(clubs);
  };

  // 모달 닫기
  window.closeClubModal = function() {
    const modal = document.getElementById('clubSelectModal');
    if (modal) modal.style.display = 'none';
  };

  // =================================================================
  // 🏢 [멀티 테넌트] 클럽 변경 (서버에 정식 로그아웃 전송 후 전환)
  // =================================================================
  window.selectClub = async function(clubId) {
    // 🏢 [멀티테넌트 수정] 전역 currentClubId 변수 충돌 방지를 위해 실제 URL 기준 구장 추출
    const currentClub = new URLSearchParams(window.location.search).get('club')
                        || window.currentClubId
                        || localStorage.getItem('preferredClubId')
                        || 'unjeong';

    if (currentClub === clubId) {
      closeClubModal();
      return;
    }

    // 💡 1. 현재 로그인 정보가 있다면 서버에 정식 로그아웃 요청 (대기열/코트 슬롯 즉시 파기)
    const rawUser = localStorage.getItem(getClubStorageKey("currentUser"));
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
          body: JSON.stringify({ user: userData, clubId: currentClub })
        });
      } catch (err) {
        console.error("❌ 클럽 변경 시 로그아웃 서버 통신 에러:", err);
      }
    }

    // 💡 2. 소켓 연결 정상 종료 (현재 구장 정보 함께 전달)
    const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
    if (activeSocket) {
      activeSocket.emit('explicitLogout', { clubId: currentClub });
      activeSocket.disconnect();
    }

    // 💡 3. 현재 구장 브라우저 세션 정리 및 새 클럽 저장
    localStorage.removeItem(getClubStorageKey("currentUser"));
    localStorage.removeItem("username");
    sessionStorage.clear();
    localStorage.setItem('preferredClubId', clubId);

    // 💡 4. 새 클럽으로 산뜻하게 이동
    window.location.href = `${window.location.pathname}?club=${clubId}`;
  };

  // 클럽 검색 필터
  window.filterClubList = function() {
    const query = (document.getElementById('clubSearchInput')?.value || '').toLowerCase().trim();
    const filtered = window.availableClubs.filter(c => c.name.toLowerCase().includes(query) || c.id.toLowerCase().includes(query));
    renderClubCards(filtered);
  };

  // 클럽 목록 백그라운드 선행 로드
  window.loadClubsData();

  // =================================================================
  // 💡 [핵심] 1. 접속 구장(URL ?club=...) 최우선 확정 및 전역 등록
  // =================================================================
  const urlParams = new URLSearchParams(window.location.search);
  const urlClub = urlParams.get('club');
  
  // URL 주소의 구장을 1순위, 없으면 저장된 구장, 둘 다 없으면 unjeong
  window.currentClubId = urlClub || localStorage.getItem('preferredClubId') || 'unjeong';
  localStorage.setItem('preferredClubId', window.currentClubId);

  // =================================================================
  // 💡 [핵심] 2. 로그인 세션 구장 검증 (타 구장 세션 침범 원천 차단)
  // =================================================================
  let savedUser = localStorage.getItem(getClubStorageKey("currentUser"));

  // 🚨 강제 로그아웃 직후 새로고침인 경우 세션 자동 복구 원천 차단
  const forcedAt = Number(localStorage.getItem(`forceLoggedOut_${window.currentClubId}`) || 0);
  if (forcedAt && (Date.now() - forcedAt < 30000)) {
    localStorage.removeItem(`forceLoggedOut_${window.currentClubId}`);
    localStorage.removeItem(getClubStorageKey("currentUser"));
    localStorage.removeItem(`currentUser_${window.currentClubId}`);
    localStorage.removeItem("currentUser");
    localStorage.removeItem("username");
    localStorage.removeItem("myName");
    localStorage.removeItem("memberName");
    sessionStorage.clear();
    savedUser = null;
  } else if (forcedAt) {
    localStorage.removeItem(`forceLoggedOut_${window.currentClubId}`);
  }

  if (savedUser) {
    try {
      let u = JSON.parse(savedUser);
      // 만약 세션에 clubId가 없거나, 현재 접속한 URL의 구장과 다르면 즉시 파기
      if (!u || typeof u !== 'object' || !u.clubId || u.clubId !== window.currentClubId) {
        localStorage.removeItem(getClubStorageKey("currentUser"));
        localStorage.removeItem("username");
        sessionStorage.clear();
        savedUser = null;
      }
    } catch (e) {
      localStorage.removeItem(getClubStorageKey("currentUser"));
      localStorage.removeItem("username");
      sessionStorage.clear();
      savedUser = null;
    }
  }

  // =================================================================
  // 💡 [핵심] 3. 화면 분기 처리 (A: 정규 세션 복구 / B: 로그인 창 진입)
  // =================================================================
  if (savedUser) {
    // A. 현재 구장과 일치하는 유효한 세션이 있을 때만 자동 로그인
    if (mainApp) {
      mainApp.style.display = 'block';
      mainApp.classList.remove("hidden");
    }
    if (introOverlay) introOverlay.classList.add("hidden");
    if (loginOverlay) loginOverlay.classList.add("hidden");
    try {
      const parsedUser = JSON.parse(savedUser);
      if (typeof socket !== 'undefined' && parsedUser) {
        // 🏢 [멀티테넌트 수정] 세션 복구 시에도 현재 구장 ID를 명확히 동봉
        socket.emit('registerUserSession', { ...parsedUser, clubId: window.currentClubId });
      }
    } catch (e) {
      console.error("소켓 유저 등록 에러:", e);
    }

    if (typeof applyUserProfile === 'function') {
      applyUserProfile();
    }
    if (typeof applyClubTitle === 'function') {
      applyClubTitle();
    }
    console.log(`✅ [${window.currentClubId}] 구장 세션이 복구되었습니다.`);
    return;
  }

  // B. 비로그인 상태: 인트로(1초) 후 해당 구장 로그인 모달 오픈
  if (introOverlay) introOverlay.classList.remove("hidden");
  if (loginOverlay) loginOverlay.classList.add("hidden");
  
  // 🛡️ [핵심 안전장치] 비로그인 유저는 메인 화면을 완벽히 숨김
  if (mainApp) {
    mainApp.style.display = 'none';
    mainApp.classList.add("hidden");
  }

  setTimeout(async () => {
    const clubs = await window.loadClubsData();
    if (introOverlay) introOverlay.classList.add("hidden");

    // 🛡️ 로그인 창 열리기 직전 메인 화면 숨김 재확인
    if (mainApp) {
      mainApp.style.display = 'none';
      mainApp.classList.add("hidden");
    }

    const currentClub = clubs.find(c => c.id === window.currentClubId);

    if (currentClub) {
      proceedToClubLogin(currentClub);
    } else {
      openClubModal(false); // 등록되지 않은 구장 ID면 클럽 선택 모달 표시
    }
  }, 1000);

  function proceedToClubLogin(club) {
    renderLoginClubHeader(club);

    if (typeof applyClubTitle === 'function') {
      applyClubTitle();
    }

    if (loginOverlay) loginOverlay.classList.remove("hidden");
    if (memberNameInput) memberNameInput.focus();
  }

  function renderLoginClubHeader(club) {
    let headerEl = document.getElementById('loginClubHeader');
    if (!headerEl && loginOverlay) {
      headerEl = document.createElement('div');
      headerEl.id = 'loginClubHeader';
      headerEl.style.cssText = 'text-align: center; margin-bottom: 14px; font-weight: 700; color: #2b6cb0; font-size: 16px;';
      const loginCard = loginOverlay.querySelector('.auth-card') || loginOverlay.firstElementChild;
      if (loginCard) loginCard.insertBefore(headerEl, loginCard.firstChild);
    }
    if (headerEl) {
      headerEl.innerHTML = `🏸 ${club.name} <button type="button" onclick="openClubModal(true)" style="
          background: transparent;
          border: 1px solid #4b5563;
          color: #9ca3af;
          font-size: 11px;
          padding: 3px 7px;
          border-radius: 4px;
          cursor: pointer;
          vertical-align: middle;
          margin-left: 6px;
          line-height: 1.2;
          transition: all 0.2s;
      " onmouseover="this.style.color='#fff'; this.style.borderColor='#9ca3af';" 
         onmouseout="this.style.color='#9ca3af'; this.style.borderColor='#4b5563';">클럽 변경</button>`;
    }
  }

  // =================================================================
  // 💡 입력 유효성 검사 함수 (이름 문자만, 전화번호 11자리, 결제번호 6자리)
  // =================================================================
  window.validateNameInput = function(input) {
    input.value = input.value.replace(/[^a-zA-Z가-힣ㄱ-ㅎㅏ-ㅣ\s]/g, '');
  };

  window.formatPhone = function(input) {
    let value = input.value.replace(/\D/g, '');
    if (value.length > 11) value = value.slice(0, 11);

    let formatted = '';
    if (value.length < 4) {
      formatted = value;
    } else if (value.length < 8) {
      formatted = value.slice(0, 3) + '-' + value.slice(3);
    } else if (value.length < 11) {
      formatted = value.slice(0, 3) + '-' + value.slice(3, 7) + '-' + value.slice(7);
    } else {
      formatted = value.slice(0, 3) + '-' + value.slice(3, 7) + '-' + value.slice(7, 11);
    }
    input.value = formatted;
  };

  window.validatePayCodeInput = function(input) {
    input.value = input.value.replace(/[^0-9]/g, '').slice(0, 6);
  };

  // =================================================================
  // 💡 로그인 탭 전환 함수 (정회원 vs 일일회원)
  // =================================================================
  window.switchTab = function(type) {
    const tabMember = document.getElementById('tabMember');
    const tabGuest = document.getElementById('tabGuest');

    if (type === 'member') {
      if (memberLoginForm) memberLoginForm.style.display = 'block';
      if (guestLoginForm) guestLoginForm.style.display = 'none';
      if (tabMember) tabMember.classList.add('active');
      if (tabGuest) tabGuest.classList.remove('active');
      
      setTimeout(() => {
        const mInput = document.getElementById('memberName');
        if (mInput) mInput.focus();
      }, 50);

    } else {
      if (memberLoginForm) memberLoginForm.style.display = 'none';
      if (guestLoginForm) guestLoginForm.style.display = 'block';
      if (tabMember) tabMember.classList.remove('active');
      if (tabGuest) tabGuest.classList.add('active');
      
      setTimeout(() => {
        const gInput = document.getElementById('guestName');
        if (gInput) gInput.focus();
      }, 50);
    }
    if (authMsg) authMsg.textContent = "";
  };

  // =================================================================
  // 💡 1. 정회원 로그인 Submit 처리 (소켓 통신)
  // =================================================================
  if (memberLoginForm) {
    memberLoginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = document.getElementById('memberName').value.trim();
      const phone = document.getElementById('memberPhone').value.trim().replace(/-/g, '');

      if (phone.length !== 11) {
        if (authMsg) authMsg.textContent = '전화번호 11자리를 정확히 입력해 주세요.';
        return;
      }

      if (typeof socket === 'undefined') {
        if (authMsg) authMsg.textContent = '서버 소켓 연결이 원활하지 않습니다.';
        return;
      }

      // 🏢 [멀티테넌트 수정] 로그인 검증 시 현재 접속 구장(clubId)을 서버에 필수 전달
      const currentClub = new URLSearchParams(window.location.search).get('club')
                          || window.currentClubId
                          || 'unjeong';

      socket.emit('loginMember', { name, phone, clubId: currentClub }, (response) => {
        if (response.success) {
          // 🏢 [멀티테넌트 수정] 저장 데이터에 현재 구장 ID(clubId)를 명확히 각인하여 타 구장 간섭 차단
          const userToSave = { ...response.user, clubId: currentClub };
          localStorage.setItem(getClubStorageKey("currentUser"), JSON.stringify(userToSave));

          socket.emit('registerUserSession', userToSave);

          if (typeof window.registerUserSocket === 'function') {
            window.registerUserSocket();
          }

          if (typeof applyUserProfile === 'function') applyUserProfile();
          if (typeof window.updateStatusRequestLink === 'function') window.updateStatusRequestLink();
          
          if (loginOverlay) loginOverlay.classList.add("hidden");
          if (mainApp) {
            mainApp.style.display = 'block';
            mainApp.classList.remove("hidden");
          }
        } else {
          const errorMsg = response.message || '등록된 정회원 정보를 찾을 수 없습니다.';
          if (authMsg) {
            authMsg.textContent = errorMsg;
          }
          if (response.statusBlocked && typeof window.openReturnRequestModal === 'function') {
            window.openReturnRequestModal(response);
          } else if (typeof showToast === 'function') {
            showToast(errorMsg, false);
          }
        }
      });
    });
  }

  // =================================================================
  // 💡 2. 일일회원 로그인 Submit 처리 (정회원 규격: grade, gender, ageGroup 일치)
  // =================================================================
  if (guestLoginForm) {
    guestLoginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = document.getElementById('guestName').value.trim();
      const phone = document.getElementById('guestPhone').value.trim().replace(/-/g, '');
      const payCode = document.getElementById('guestPayCode').value.trim();

      const gender = document.getElementById('guestGender') ? document.getElementById('guestGender').value : '';
      const ageGroup = document.getElementById('guestAge') ? document.getElementById('guestAge').value : '';
      const grade = document.getElementById('guestLevel') ? document.getElementById('guestLevel').value : '';

      if (phone.length !== 11) {
        if (authMsg) authMsg.textContent = '전화번호 11자리를 정확히 입력해 주세요.';
        return;
      }
      if (payCode.length !== 6) {
        if (authMsg) authMsg.textContent = '결제인증번호 6자리를 정확히 입력해 주세요.';
        return;
      }

      if (typeof socket === 'undefined') {
        if (authMsg) authMsg.textContent = '서버 소켓 연결이 원활하지 않습니다.';
        return;
      }

      // 🏢 [멀티테넌트 수정] 일일회원 로그인 시에도 현재 접속 구장(clubId)을 서버에 필수 전달
      const currentClub = new URLSearchParams(window.location.search).get('club')
                          || window.currentClubId
                          || 'unjeong';

      socket.emit('loginGuest', { name, phone, payCode, gender, ageGroup, grade, clubId: currentClub }, (response) => {
        if (response.success) {
          // 🏢 [멀티테넌트 수정] 저장 데이터에 현재 구장 ID(clubId) 각인
          const userToSave = { ...response.user, clubId: currentClub };
          localStorage.setItem(getClubStorageKey("currentUser"), JSON.stringify(userToSave));

          socket.emit('registerUserSession', userToSave);

          if (typeof window.registerUserSocket === 'function') {
            window.registerUserSocket();
          }

          if (typeof applyUserProfile === 'function') applyUserProfile();

          if (typeof window.updateStatusRequestLink === 'function') window.updateStatusRequestLink();
          
          if (loginOverlay) loginOverlay.classList.add("hidden");
          if (mainApp) {
            mainApp.style.display = 'block';
            mainApp.classList.remove("hidden");
          }
        } else {
          if (authMsg) authMsg.textContent = response.message || '일일회원 입장에 실패했습니다.';
        }
      });
    });
  }
});

// =================================================================
  // 🏷️ [회원 상태 관리] 병가·휴면·탈퇴 신청 및 복귀/재입회 팝업 제어
  // =================================================================
  let blockedMemberContext = null;

  window.updateStatusRequestLink = function() {
    const wrap = document.getElementById('member-status-request-wrap');
    if (!wrap) return;
    try {
      const saved = JSON.parse(localStorage.getItem(getClubStorageKey("currentUser")) || 'null');
      const isRegularMember = Boolean(saved && !saved.isGuest && saved.name && saved.phone);
      wrap.style.display = isRegularMember ? 'inline-flex' : 'none';
    } catch (e) {
      wrap.style.display = 'none';
    }
  };
  window.updateStatusRequestLink();

  window.toggleUserReqDateField = function() {
    const typeEl = document.getElementById('req-status-type');
    const wrap = document.getElementById('req-end-date-wrap');
    if (!typeEl || !wrap) return;
    wrap.style.display = (typeEl.value === 'sick' || typeEl.value === 'dormant') ? 'block' : 'none';
  };

  window.openStatusRequestModal = function() {
    const modal = document.getElementById('status-request-modal');
    if (!modal) return;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(getClubStorageKey("currentUser")) || 'null'); } catch (e) {}
    if (!saved || saved.isGuest) {
      if (typeof showToast === 'function') showToast('정회원 로그인 상태에서만 신청할 수 있습니다.', false);
      return;
    }
    const labelEl = document.getElementById('status-req-member-label');
    if (labelEl) labelEl.textContent = `신청 회원: ${saved.name} (${saved.phone})`;
    const typeEl = document.getElementById('req-status-type');
    if (typeEl) typeEl.value = 'sick';
    const dateEl = document.getElementById('req-end-date');
    if (dateEl) dateEl.value = '';
    const reasonEl = document.getElementById('req-status-reason');
    if (reasonEl) reasonEl.value = '';
    window.toggleUserReqDateField();
    modal.style.display = 'flex';
  };

  window.closeStatusRequestModal = function() {
    const modal = document.getElementById('status-request-modal');
    if (modal) modal.style.display = 'none';
  };

  window.submitMemberStatusRequest = async function() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(getClubStorageKey("currentUser")) || 'null'); } catch (e) {}
    if (!saved || saved.isGuest) return;

    const requestedStatus = document.getElementById('req-status-type')?.value || 'sick';
    const endDate = document.getElementById('req-end-date')?.value || '';
    const reason = (document.getElementById('req-status-reason')?.value || '').trim();
    const clubId = saved.clubId || new URLSearchParams(window.location.search).get('club') || window.currentClubId || 'unjeong';

    try {
      const res = await fetch('/api/member/status-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: saved.name, phone: saved.phone, clubId, requestedStatus, endDate, reason })
      });
      const result = await res.json();
      if (result.success) {
        window.closeStatusRequestModal();
        if (typeof showToast === 'function') showToast(result.message, true);
        else alert(result.message);
      } else {
        if (typeof showToast === 'function') showToast(result.message || '신청에 실패했습니다.', false);
        else alert(result.message || '신청에 실패했습니다.');
      }
    } catch (err) {
      if (typeof showToast === 'function') showToast('서버 통신 중 오류가 발생했습니다.', false);
    }
  };

  window.openReturnRequestModal = function(response) {
    const modal = document.getElementById('return-request-modal');
    if (!modal || !response || !response.memberInfo) return;
    blockedMemberContext = response;

    const info = response.memberInfo;
    const st = response.memberStatus;
    const titleMap = { sick: '🩹 병가 회원 안내', dormant: '⏸️ 휴면 회원 안내', withdrawn: '🚪 탈퇴 회원 안내' };
    const titleEl = document.getElementById('return-modal-title');
    const descEl = document.getElementById('return-modal-desc');
    const btnEl = document.getElementById('btn-submit-return-req');
    const reasonWrap = document.getElementById('return-reason-wrap');
    const reasonInput = document.getElementById('return-request-reason');

    if (titleEl) titleEl.textContent = titleMap[st] || '회원 상태 안내';
    const dateLines = [];
    if (info.statusUpdatedAt) dateLines.push(`처리일: ${info.statusUpdatedAt}`);
    if (info.statusEndDate) dateLines.push(`예정일: ~${info.statusEndDate}`);
    if (info.statusMemo) dateLines.push(`사유: ${info.statusMemo}`);

    if (descEl) {
      descEl.innerHTML = `<strong>${info.name}</strong> 님은 현재 정회원 로그인이 제한된 상태입니다.`
        + (dateLines.length ? `<div style="margin-top:6px; padding:8px 10px; background:#0f172a; border-radius:6px; font-size:12px; color:#cbd5e1;">${dateLines.join(' · ')}</div>` : '')
        + `<div style="margin-top:8px; font-size:12.5px; color:#94a3b8;">정회원 복귀(재입회)를 신청하시거나, 오늘만 방문 운동 시 일일회원으로 입장해 주세요.</div>`;
    }

    if (reasonInput) reasonInput.value = '';
    if (btnEl) {
      if (response.hasPendingReturn) {
        btnEl.disabled = true;
        btnEl.style.opacity = '0.6';
        btnEl.textContent = '⏳ 복귀/재입회 승인 대기 중';
        if (reasonWrap) reasonWrap.style.display = 'none';
      } else {
        btnEl.disabled = false;
        btnEl.style.opacity = '1';
        btnEl.textContent = st === 'withdrawn' ? '🔄 정회원 간편 재입회 신청하기' : '🔄 정회원 복귀 신청하기';
        if (reasonWrap) reasonWrap.style.display = 'block';
      }
    }

    modal.style.display = 'flex';
  };

  window.closeReturnRequestModal = function() {
    const modal = document.getElementById('return-request-modal');
    if (modal) modal.style.display = 'none';
  };

  window.submitReturnRequest = async function() {
    if (!blockedMemberContext || !blockedMemberContext.memberInfo) return;
    const info = blockedMemberContext.memberInfo;
    const reason = (document.getElementById('return-request-reason')?.value || '').trim();

    try {
      const res = await fetch('/api/member/status-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: info.name,
          phone: info.phone,
          clubId: info.clubId,
          requestedStatus: 'active',
          reason
        })
      });
      const result = await res.json();
      if (result.success) {
        window.closeReturnRequestModal();
        if (typeof showToast === 'function') showToast(result.message, true);
        else alert(result.message);
      } else {
        if (typeof showToast === 'function') showToast(result.message || '신청에 실패했습니다.', false);
      }
    } catch (err) {
      if (typeof showToast === 'function') showToast('서버 통신 중 오류가 발생했습니다.', false);
    }
  };

  window.switchToGuestWithPrefill = function() {
    const info = blockedMemberContext && blockedMemberContext.memberInfo;
    window.closeReturnRequestModal();
    if (typeof window.switchTab === 'function') {
      window.switchTab('guest');
    }
    if (info) {
      const gName = document.getElementById('guestName');
      const gPhone = document.getElementById('guestPhone');
      if (gName) gName.value = info.name || '';
      if (gPhone) gPhone.value = String(info.phone || '').replace(/[^0-9]/g, '');
      setTimeout(() => {
        const payInput = document.getElementById('guestPayCode');
        if (payInput) payInput.focus();
      }, 80);
    }
  };
  
// ==========================================
// 팝업 알림(토스트 메시지)을 띄워주는 함수
// ==========================================
function showToast(message, isSuccess = true) {
    const existingToast = document.getElementById('custom-toast');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.id = 'custom-toast';
    toast.textContent = message;
    
    toast.style.position = 'fixed';
    toast.style.top = '20%';
    toast.style.left = '50%';
    toast.style.transform = 'translate(-50%, -50%)';
    toast.style.backgroundColor = isSuccess ? '#10b981' : '#ef4444';
    toast.style.color = '#ffffff';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = '8px';
    toast.style.fontSize = '15px';
    toast.style.fontWeight = 'bold';
    toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    toast.style.zIndex = '2147483647';
    toast.style.transition = 'opacity 0.3s ease';

    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

// ==========================================
// [통합 완료] 정회원 가입 신청 폼 제출 처리 함수
// ==========================================
async function handleRegisterSubmit(event) {
    if (event) event.preventDefault();

    const regErrorEl = document.getElementById('regErrorMsg');
    if (regErrorEl) {
        regErrorEl.style.display = 'none';
        regErrorEl.textContent = '';
    }

    const showTopAlert = async (msg, isError = true) => {
        if (isError && regErrorEl) {
            regErrorEl.textContent = msg;
            regErrorEl.style.display = 'block';
        } else {
            alert(msg);
        }
    };

    const hideRegisterModal = () => {
        if (typeof closeRegisterModal === 'function') {
            closeRegisterModal();
        } else {
            const modal = document.getElementById('register-modal') || document.getElementById('registerModal');
            if (modal) modal.style.display = 'none';
        }
    };

    const nameInput = document.getElementById('regName');
    const phoneInput = document.getElementById('regPhone');
    const birthInput = document.getElementById('regBirthDate');

    const cleanName = String(nameInput ? nameInput.value : '')
        .replace(/\([^)]*\)/g, '')
        .replace(/[^가-힣a-zA-Z]/g, '')
        .trim();
    const cleanPhone = String(phoneInput ? phoneInput.value : '').replace(/[^0-9]/g, '');
    const cleanBirth = String(birthInput ? birthInput.value : '').replace(/[^0-9]/g, '');

    if (cleanName.length < 2) {
        await showTopAlert('이름은 한글 또는 영문 2자 이상 정확히 입력해 주세요.');
        if (nameInput) nameInput.focus();
        return;
    }
    if (cleanPhone.length < 10 || cleanPhone.length > 11) {
        await showTopAlert('전화번호는 하이픈 없이 숫자 10~11자리로 입력해 주세요.\n(예: 01012345678)');
        if (phoneInput) phoneInput.focus();
        return;
    }
    if (cleanBirth.length !== 8) {
        await showTopAlert('생년월일은 숫자 8자리로 정확히 입력해 주세요.\n(예: 19780116)');
        if (birthInput) birthInput.focus();
        return;
    }

    // 실제 달력에 존재하는 날짜(윤년·월별 일수·미래 날짜)인지 클라이언트 1차 검증
    const bYear = parseInt(cleanBirth.slice(0, 4), 10);
    const bMonth = parseInt(cleanBirth.slice(4, 6), 10);
    const bDay = parseInt(cleanBirth.slice(6, 8), 10);
    const bDate = new Date(bYear, bMonth - 1, bDay);
    const today = new Date();
    const isValidBirth =
        bYear >= 1920 &&
        bDate <= today &&
        bDate.getFullYear() === bYear &&
        bDate.getMonth() + 1 === bMonth &&
        bDate.getDate() === bDay;

    if (!isValidBirth) {
        await showTopAlert('존재하지 않거나 올바르지 않은 생년월일입니다.\n다시 확인해 주세요. (예: 19780116)');
        if (birthInput) birthInput.focus();
        return;
    }

    // 🏢 [멀티테넌트] URL 파라미터(?club=) 및 window.currentClubId를 최우선으로 추출
    const urlParams = new URLSearchParams(window.location.search);
    const clubId = String(
        urlParams.get('club')
        || urlParams.get('clubId')
        || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
        || localStorage.getItem('preferredClubId')
        || 'unjeong'
    ).trim();

    const formData = {
        name: cleanName,
        phone: cleanPhone,
        gender: document.getElementById('regGender').value,
        birthDate: cleanBirth,
        grade: document.getElementById('regGrade').value,
        address: document.getElementById('regAddress') ? document.getElementById('regAddress').value.trim() : '',
        clubId: clubId
    };

    const submitBtn = document.querySelector('#registerForm button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData)
        });

        const result = await response.json();

        if (result.success) {
            hideRegisterModal();
            const form = document.getElementById('registerForm');
            if (form) form.reset();

            await showTopAlert(result.message || '정회원 가입 신청이 완료되었습니다.\n관리자 승인 대기중입니다.');
        } else {
            const errMsg = result.message || '가입 신청에 실패했습니다.';

            if (errMsg.includes('이미')) {
                hideRegisterModal();
                const form = document.getElementById('registerForm');
                if (form) form.reset();
            }

            await showTopAlert(errMsg);
        }
    } catch (error) {
        console.error('가입 신청 통신 오류:', error);
        await showTopAlert('서버와의 통신 중 오류가 발생했습니다.');
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

window.handleRegisterSubmit = handleRegisterSubmit;

// 입력칸 숫자/문자 전용 강제 잠금 (붙여넣기·모바일 키보드 포함)
document.addEventListener('DOMContentLoaded', () => {
    const nameInput = document.getElementById('regName');
    if (nameInput) {
        nameInput.addEventListener('blur', (e) => {
            e.target.value = e.target.value
                .replace(/\([^)]*\)/g, '')
                .replace(/[^가-힣a-zA-Z]/g, '')
                .trim()
                .slice(0, 10);
        });
    }

    const phoneInput = document.getElementById('regPhone');
    if (phoneInput) {
        phoneInput.addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 11);
        });
    }

    const birthInput = document.getElementById('regBirthDate');
    if (birthInput) {
        birthInput.addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 8);
        });
    }
});