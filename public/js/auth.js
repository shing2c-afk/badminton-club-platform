// public/js/auth.js

document.addEventListener("DOMContentLoaded", () => {
  const introOverlay = document.getElementById("auth-intro-overlay");
  const loginOverlay = document.getElementById("auth-login-overlay");
  const dummySelect = document.getElementById("auth-dummy-select"); // HTML의 드롭다운 ID
  const loginForm = document.getElementById("auth-login-form");
  const usernameInput = document.getElementById("auth-username");
  const authMsg = document.getElementById("auth-msg");

  // 1. 2초 후 인트로 오버레이 페이드아웃 및 로그인 레이어 표시
  setTimeout(() => {
    if (introOverlay) introOverlay.classList.add("hidden");
    if (loginOverlay) loginOverlay.classList.remove("hidden");
    fetchRegularMembers(); // 💡 DB 기반 회원 목록 조회 함수 호출로 변경
  }, 2000);

  // 2. 서버 DB에서 정회원 목록 가져오기 (API 경로 수정 반영)
  async function fetchRegularMembers() {
    try {
      const res = await fetch("/api/users/list");
      const data = await res.json();

      if (data.success && dummySelect) {
        dummySelect.innerHTML = '<option value="">-- 계정 선택 (선택사항) --</option>';
        data.users.forEach(u => {
          const opt = document.createElement("option");
          
          // 💡 핵심 수정: input창에 들어갈 값(username)을 명확히 지정
          opt.value = u.username || u.id; 
          
          // 화면에 보이는 텍스트
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
          if (typeof applyUserProfile === 'function') applyUserProfile();
          
          // 로그인 레이어 닫기 -> 메인 화면 노출!
          loginOverlay.classList.add("hidden");
        } else {
          if (authMsg) authMsg.textContent = result.message;
        }
      } catch (err) {
        if (authMsg) authMsg.textContent = "서버 통신 오류가 발생했습니다.";
      }
    });
  }
});