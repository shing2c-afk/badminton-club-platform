// public/js/auth.js

document.addEventListener("DOMContentLoaded", () => {
  const introOverlay = document.getElementById("auth-intro-overlay");
  const loginOverlay = document.getElementById("auth-login-overlay");
  const mainApp = document.getElementById("main-app"); // 메인 앱 화면
  const dummySelect = document.getElementById("auth-dummy-select");
  const loginForm = document.getElementById("auth-login-form");
  const usernameInput = document.getElementById("auth-username");
  const authMsg = document.getElementById("auth-msg");

  // =================================================================
  // 💡 [핵심] 새로고침 시 세션 유지 및 깜빡임 없는 화면 분기 처리
  // =================================================================
  const savedUser = localStorage.getItem("currentUser");
  
  if (savedUser) {
    // 1. 로그인 정보가 있는 경우: 인트로/로그인 창은 숨긴 채 메인 앱만 즉시 노출
    if (mainApp) mainApp.classList.remove("hidden");
    if (introOverlay) introOverlay.classList.add("hidden");
    if (loginOverlay) loginOverlay.classList.add("hidden");

    // 💡 [추가] 자동 로그인(새로고침) 시점에도 서버 소켓에 유저 아이디 등록
    try {
      const parsedUser = JSON.parse(savedUser);
      if (typeof socket !== 'undefined' && parsedUser.username) {
        socket.emit('registerUser', parsedUser.username);
      }
    } catch (e) {
      console.error("소켓 유저 등록 에러:", e);
    }

    if (typeof applyUserProfile === 'function') {
      applyUserProfile();
    }
    console.log("✅ 깜빡임 없이 자동 로그인(세션 유지)되었습니다.");
    return; // 타이머 실행을 막기 위해 여기서 종료
  }

  // -----------------------------------------------------------------
  // 💡 로그인 정보가 '없는 경우'에만 인트로 및 로그인 로직 실행
  // -----------------------------------------------------------------
  
  // 비로그인 상태이므로 인트로 화면을 노출 시작 (CSS와 HTML에 의해 숨겨져 있던 것을 해제)
  if (introOverlay) introOverlay.classList.remove("hidden"); 

  // 1. 2초 후 인트로 오버레이 페이드아웃 및 로그인 레이어 표시
  setTimeout(() => {
    if (introOverlay) introOverlay.classList.add("hidden");
    if (loginOverlay) loginOverlay.classList.remove("hidden");
    fetchRegularMembers(); // DB 기반 회원 목록 조회 함수 호출
  }, 2000);

  // 2. 서버 DB에서 정회원 목록 가져오기
  async function fetchRegularMembers() {
    try {
      const res = await fetch('/api/members');
      const data = await res.json();

      if (Array.isArray(data) && dummySelect) {
        dummySelect.innerHTML = '<option value="">-- 계정 선택 (선택사항) --</option>';
        data.forEach(u => {
          const opt = document.createElement("option");
          opt.value = u.username; 
          opt.textContent = `${u.name} (${u.ageGroup} / ${u.grade})`;
          dummySelect.appendChild(opt);
        });
      }
    } catch (err) {
      console.error("정회원 목록 조회 실패:", err);
    }
  }

  // 3. 더미 계정 선택 시 아이디 자동 입력
  if (dummySelect) {
    dummySelect.addEventListener("change", (e) => {
      if (usernameInput) usernameInput.value = e.target.value;
    });
  }

  // 4. 로그인 Submit 처리
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = usernameInput.value;
      const password = document.getElementById("auth-password").value;

      try {
        const res = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password })
        });
        const result = await res.json();

        if (result.success) {
          // 세션 정보 저장
          localStorage.setItem("currentUser", JSON.stringify(result.user));
          
          // 💡 [추가] 일반 로그인 성공 시점에도 서버 소켓에 유저 아이디 등록
          if (typeof socket !== 'undefined' && result.user.username) {
            socket.emit('registerUser', result.user.username);
          }

          if (typeof applyUserProfile === 'function') applyUserProfile();
          
          // 로그인 레이어 닫고, 메인 앱 화면 열기
          if (loginOverlay) loginOverlay.classList.add("hidden");
          if (mainApp) mainApp.classList.remove("hidden");
        } else {
          if (authMsg) authMsg.textContent = result.message;
        }
      } catch (err) {
        if (authMsg) authMsg.textContent = "서버 통신 오류가 발생했습니다.";
      }
    });
  }
});