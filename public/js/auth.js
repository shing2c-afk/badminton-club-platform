// 🔑 현재 접속한 구장별 스토리지 키 생성 헬퍼
function getClubStorageKey(baseKey) {
  const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                 || new URLSearchParams(window.location.search).get('club') 
                 || 'default';
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

    const currentClubId = localStorage.getItem('preferredClubId');
    if (!clubs || clubs.length === 0) {
      container.innerHTML = '<div class="club-loading">운영 중인 클럽이 없습니다.</div>';
      return;
    }

    container.innerHTML = clubs.map(club => {
      const isCurrent = club.id === currentClubId;
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
    const currentClubId = localStorage.getItem('preferredClubId');
    if (currentClubId === clubId) {
      closeClubModal();
      return;
    }

    // 💡 1. 현재 로그인 정보가 있다면 서버에 정식 로그아웃 요청 (대기열/코트 슬롯 즉시 파기)
    const currentClub = (typeof currentClubId !== 'undefined' && currentClubId) 
                        || new URLSearchParams(window.location.search).get('club') 
                        || 'default';

    // 🔑 [수정] 현재 구장 전용 키로 조회
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
          // 📡 서버 로그아웃 시 구장 정보도 함께 전달
          body: JSON.stringify({ user: userData, clubId: currentClub })
        });
      } catch (err) {
        console.error("❌ 클럽 변경 시 로그아웃 서버 통신 에러:", err);
      }
    }

    // 💡 2. 소켓 연결 정상 종료
    const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
    if (activeSocket) {
      activeSocket.emit('explicitLogout'); // 👈 이 신호 한 줄 추가!
      activeSocket.disconnect();
    }

    // 💡 3. 브라우저 세션 정리 및 새 클럽 저장
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
  // 🔑 [수정] 현재 구장 전용 키로 조회
  let savedUser = localStorage.getItem(getClubStorageKey("currentUser"));

  if (savedUser) {
    try {
      let u = JSON.parse(savedUser);
      // 만약 세션에 clubId가 없거나, 현재 접속한 URL의 구장과 다르면 즉시 파기
      if (!u || typeof u !== 'object' || !u.clubId || u.clubId !== window.currentClubId) {
        localStorage.removeItem(getClubStorageKey("currentUser"));
        localStorage.removeItem("username");
        sessionStorage.clear();
        savedUser = null; // 현재 페이지에서 비로그인 상태로 즉시 전환
      }
    } catch (e) {
      // JSON 파싱 에러 발생 시 즉시 파기
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
    if (mainApp) mainApp.classList.remove("hidden");
    if (introOverlay) introOverlay.classList.add("hidden");
    if (loginOverlay) loginOverlay.classList.add("hidden");

    try {
      const parsedUser = JSON.parse(savedUser);
      if (typeof socket !== 'undefined' && parsedUser) {
        socket.emit('registerUserSession', parsedUser);
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

  setTimeout(async () => {
    const clubs = await window.loadClubsData();
    if (introOverlay) introOverlay.classList.add("hidden");

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

  // 📌 로그인 창 전화번호 실시간 하이픈 적용을 위한 함수 추가
  window.formatPhone = function(input) {
    let value = input.value.replace(/\D/g, ''); // 숫자만 남기기
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
      
      // 정회원 탭으로 전환될 때 이름 입력창에 포커스를 주어 한글 자판 유도
      setTimeout(() => {
        const mInput = document.getElementById('memberName');
        if (mInput) mInput.focus();
      }, 50);

    } else {
      if (memberLoginForm) memberLoginForm.style.display = 'none';
      if (guestLoginForm) guestLoginForm.style.display = 'block';
      if (tabMember) tabMember.classList.remove('active');
      if (tabGuest) tabGuest.classList.add('active');
      
      // 일일회원 탭으로 전환될 때 이름 입력창에 포커스를 주어 한글 자판 유도
      setTimeout(() => {
        const gInput = document.getElementById('guestName');
        if (gInput) gInput.focus();
      }, 50);
    }
    if (authMsg) authMsg.textContent = ""; // 메시지 초기화
  };

  // =================================================================
  // 💡 1. 정회원 로그인 Submit 처리 (소켓 통신)
  // =================================================================
  if (memberLoginForm) {
    memberLoginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = document.getElementById('memberName').value.trim();
      // 📌 하이픈(-)을 제거하여 순수 11자리 숫자로 변환 후 검증 및 전송
      const phone = document.getElementById('memberPhone').value.trim().replace(/-/g, '');

      if (phone.length !== 11) {
        if (authMsg) authMsg.textContent = '전화번호 11자리를 정확히 입력해 주세요.';
        return;
      }

      if (typeof socket === 'undefined') {
        if (authMsg) authMsg.textContent = '서버 소켓 연결이 원활하지 않습니다.';
        return;
      }

      // 서버로 정회원 로그인 요청
      socket.emit('loginMember', { name, phone }, (response) => {
        if (response.success) {
          // 🔑 [구장 키 추출] URL 파라미터 또는 전역 변수에서 현재 clubId 확인
          const currentClub = (typeof currentClubId !== 'undefined' && currentClubId) 
                              ? currentClubId 
                              : (new URLSearchParams(window.location.search).get('club') || 'default');

         // 💾 [수정] 헬퍼 함수를 사용하여 현재 구장 전용 키로 저장
          localStorage.setItem(getClubStorageKey("currentUser"), JSON.stringify(response.user));

          // 📡 서버로 세션 등록 시 구장 정보(clubId)도 함께 전달
          socket.emit('registerUserSession', { 
            ...response.user, 
            clubId: currentClub 
          });

          // ✅ 로그인 성공 즉시 소켓 채널 등록 및 접속자 카운트 갱신!
          if (typeof window.registerUserSocket === 'function') {
            window.registerUserSocket();
          }

          if (typeof applyUserProfile === 'function') applyUserProfile();
          
          if (loginOverlay) loginOverlay.classList.add("hidden");
          if (mainApp) mainApp.classList.remove("hidden");
        } else {
          if (authMsg) authMsg.textContent = response.message || '등록된 정회원 정보를 찾을 수 없습니다.';
        }
      });
    });
  }

  // =================================================================
  // 💡 2. 일일회원 로그인 Submit 처리 (소켓 통신)
  // =================================================================
  if (guestLoginForm) {
    guestLoginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = document.getElementById('guestName').value.trim();
      // 📌 하이픈(-)을 제거하여 순수 11자리 숫자로 변환 후 검증 및 전송
      const phone = document.getElementById('guestPhone').value.trim().replace(/-/g, '');
      const payCode = document.getElementById('guestPayCode').value.trim();

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

      // 서버로 일일회원 로그인 요청
      socket.emit('loginGuest', { name, phone, payCode }, (response) => {
        if (response.success) {
          // 💾 [수정] 현재 구장 전용 키로 저장
          localStorage.setItem(getClubStorageKey("currentUser"), JSON.stringify(response.user));

          // 📡 [수정] 구장 정보를 포함하여 세션 등록
          const currentClub = (typeof currentClubId !== 'undefined' && currentClubId) 
                              || new URLSearchParams(window.location.search).get('club') 
                              || 'default';
          socket.emit('registerUserSession', { 
            ...response.user, 
            clubId: currentClub 
          });

          // ✅ [추가] 로그인 성공 즉시 소켓 채널 등록 및 접속자 카운트 갱신!
          if (typeof window.registerUserSocket === 'function') {
            window.registerUserSocket();
          }

          if (typeof applyUserProfile === 'function') applyUserProfile();
          
          if (loginOverlay) loginOverlay.classList.add("hidden");
          if (mainApp) mainApp.classList.remove("hidden");
        } else {
          if (authMsg) authMsg.textContent = response.message || '일일회원 입장에 실패했습니다.';
        }
      });
    });
  }
});

// ==========================================
// 팝업 알림(토스트 메시지)을 띄워주는 함수
// ==========================================
function showToast(message, isSuccess = true) {
    // 기존에 이미 떠있는 토스트가 있다면 제거
    const existingToast = document.getElementById('custom-toast');
    if (existingToast) existingToast.remove();

    // 토스트 요소 생성
    const toast = document.createElement('div');
    toast.id = 'custom-toast';
    toast.textContent = message;
    
    // 스타일 지정 (화면 중앙 상단에 깔끔하게 표시)
    toast.style.position = 'fixed';
    toast.style.top = '20%';
    toast.style.left = '50%';
    toast.style.transform = 'translate(-50%, -50%)';
    toast.style.backgroundColor = isSuccess ? '#10b981' : '#ef4444'; // 성공: 초록색, 실패: 빨간색
    toast.style.color = '#ffffff';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = '8px';
    toast.style.fontSize = '15px';
    toast.style.fontWeight = 'bold';
    toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    toast.style.zIndex = '2147483647';
    toast.style.transition = 'opacity 0.3s ease';

    document.body.appendChild(toast);

    // 2초 뒤에 서서히 사라지면서 제거
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

// ==========================================
// [통합 완료] 정회원 가입 신청 폼 제출 처리 함수
// ==========================================
async function handleRegisterSubmit(event) {
    event.preventDefault(); // 폼 제출로 인한 새로고침 방지

    // 💡 1. 현재 구장 식별자 추출 (기본값 unjeong)
    const urlParams = new URLSearchParams(window.location.search);
    const clubId = (typeof currentClub !== 'undefined' && currentClub) || 
                   (typeof currentClubId !== 'undefined' && currentClubId) || 
                   urlParams.get('club') || 
                   urlParams.get('clubId') || 
                   'unjeong';

    // 💡 2. 입력 데이터 수집 (clubId 포함)
    const formData = {
        name: document.getElementById('regName').value.trim(),
        phone: document.getElementById('regPhone').value.trim(),
        gender: document.getElementById('regGender').value,
        birthDate: document.getElementById('regBirthDate').value.trim(),
        grade: document.getElementById('regGrade').value,
        address: document.getElementById('regAddress') ? document.getElementById('regAddress').value.trim() : '',
        clubId: clubId // 📌 현재 구장(daewon / unjeong) 전송
    };

    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData)
        });

        const result = await response.json();

        if (result.success) {
            // 📌 성공 토스트 팝업 출력
            showToast(result.message || '가입 신청이 완료되었습니다.', true);
            
            // 1.5초 후 모달 닫기 및 폼 초기화
            setTimeout(() => {
                if (typeof closeRegisterModal === 'function') closeRegisterModal();
                const form = document.getElementById('registerForm');
                if (form) form.reset();
            }, 1500);
        } else {
            // 📌 실패 에러 토스트 출력
            showToast(result.message || '가입 신청에 실패했습니다.', false);
        }
    } catch (error) {
        console.error('가입 신청 통신 오류:', error);
        showToast('서버와의 통신 중 오류가 발생했습니다.', false);
    }
}
document.addEventListener('DOMContentLoaded', () => {
    // 1. 전화번호 실시간 자동 하이픈 (010-XXXX-XXXX)
    const phoneInput = document.getElementById('regPhone');
    if (phoneInput) {
        phoneInput.addEventListener('input', (e) => {
            let value = e.target.value.replace(/\D/g, ''); // 숫자만 남기기
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
            e.target.value = formatted;
        });
    }

    // 2. 생년월일 실시간 자동 하이픈 (2000-01-01)
    const birthInput = document.getElementById('regBirthDate');
    if (birthInput) {
        birthInput.addEventListener('input', (e) => {
            let value = e.target.value.replace(/\D/g, ''); // 숫자만 남기기
            if (value.length > 8) value = value.slice(0, 8);

            let formatted = '';
            if (value.length <= 4) {
                formatted = value;
            } else if (value.length <= 6) {
                formatted = value.slice(0, 4) + '-' + value.slice(4);
            } else {
                formatted = value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6, 8);
            }
            e.target.value = formatted;
        });
    }
});