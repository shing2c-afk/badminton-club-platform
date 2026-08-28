// public/js/auth.js

document.addEventListener("DOMContentLoaded", () => {
  const introOverlay = document.getElementById("auth-intro-overlay");
  const loginOverlay = document.getElementById("auth-login-overlay");
  const mainApp = document.getElementById("main-app"); // 메인 앱 화면

  // 폼 및 입력 요소
  const memberLoginForm = document.getElementById("memberLoginForm");
  const guestLoginForm = document.getElementById("guestLoginForm");
  const authMsg = document.getElementById("auth-msg");

  // =================================================================
  // 💡 [수정] 이름 입력 필드 한글 강제 설정 및 포커스 이벤트 처리
  // =================================================================
  const memberNameInput = document.getElementById('memberName');
  const guestNameInput = document.getElementById('guestName');

  [memberNameInput, guestNameInput].forEach(input => {
    if (input) {
      input.setAttribute('lang', 'ko');
      input.setAttribute('inputmode', 'text'); // 모바일에서 한글 키보드 유도 최적화
      
      // 포커스가 들어올 때마다 한글 모드 속성을 재확인하고 강제 포커싱 유지 유도
      input.addEventListener('focus', () => {
        input.setAttribute('lang', 'ko');
      });
    }
  });

  // =================================================================
  // 💡 [핵심] 새로고침 시 세션 유지 및 깜빡임 없는 화면 분기 처리
  // =================================================================
  const savedUser = localStorage.getItem("currentUser");
  
  if (savedUser) {
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
    console.log("✅ 깜빡임 없이 자동 로그인(세션 유지)되었습니다.");
    return;
  }

  // -----------------------------------------------------------------
  // 💡 비로그인 상태: 인트로 화면 노출 후 로그인 레이어 표시
  // -----------------------------------------------------------------
  if (introOverlay) introOverlay.classList.remove("hidden"); 

  setTimeout(() => {
    if (introOverlay) introOverlay.classList.add("hidden");
    if (loginOverlay) loginOverlay.classList.remove("hidden");
    
    // 로그인 창이 처음 뜰 때 정회원 이름 input에 자동으로 포커스를 주어 바로 한글 키보드가 올라오도록 유도
    if (memberNameInput) {
      memberNameInput.focus();
    }
  }, 2000);

  // =================================================================
  // 💡 입력 유효성 검사 함수 (이름 문자만, 전화번호 11자리, 결제번호 6자리)
  // =================================================================
  window.validateNameInput = function(input) {
    input.value = input.value.replace(/[^a-zA-Z가-힣ㄱ-ㅎㅏ-ㅣ\s]/g, '');
  };

  window.validatePhoneInput = function(input) {
    input.value = input.value.replace(/[^0-9]/g, '').slice(0, 11);
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
      const phone = document.getElementById('memberPhone').value.trim();

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
          localStorage.setItem("currentUser", JSON.stringify(response.user));

          socket.emit('registerUserSession', response.user);
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
      const phone = document.getElementById('guestPhone').value.trim();
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
          localStorage.setItem("currentUser", JSON.stringify(response.user));

          socket.emit('registerUserSession', response.user);
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