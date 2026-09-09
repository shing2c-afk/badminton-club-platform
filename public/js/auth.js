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

// [추가] 정회원 가입 신청 제출 처리 함수
async function handleRegisterSubmit(event) {
    event.preventDefault();

    const name = document.getElementById('regName').value.trim();
    const phone = document.getElementById('regPhone').value.trim();
    const gender = document.getElementById('regGender').value;
    const birthDate = document.getElementById('regBirthDate').value;
    const grade = document.getElementById('regGrade').value;
    const msgDiv = document.getElementById('reg-msg');

    msgDiv.textContent = '가입 신청 중입니다...';
    msgDiv.style.color = '#3b82f6';

    try {
        const response = await fetch('/api/register-request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, phone, gender, birthDate, grade })
        });

        const result = await response.json();

        if (response.ok) {
            msgDiv.textContent = '✨ 가입 신청이 완료되었습니다! 관리자 승인 후 로그인할 수 있습니다.';
            msgDiv.style.color = '#10b981';
            
            // 2초 후 모달 창 닫기 및 폼 초기화
            setTimeout(() => {
                document.getElementById('registerForm').reset();
                closeRegisterModal();
                msgDiv.textContent = '';
            }, 2000);
        } else {
            msgDiv.textContent = `❌ ${result.message || '가입 신청에 실패했습니다.'}`;
            msgDiv.style.color = '#ff4d4f';
        }
    } catch (error) {
        console.error('가입 신청 에러:', error);
        msgDiv.textContent = '❌ 서버 통신 중 오류가 발생했습니다.';
        msgDiv.style.color = '#ff4d4f';
    }
}
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
    
    // 스타일 지정 (화면 중앙 상단 또는 정중앙에 멋지게 표시)
    toast.style.position = 'fixed';
    toast.style.top = '20%';
    toast.style.left = '50%';
    toast.style.transform = 'translate(-50%, -50%)';
    toast.style.backgroundColor = isSuccess ? '#10b981' : '#ef4444'; // 성공은 초록색, 실패는 빨간색
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
// 정회원 가입 신청 폼 제출 처리 함수
// ==========================================
async function handleRegisterSubmit(event) {
    event.preventDefault(); // 폼 제출로 인한 페이지 새로고침 방지

    const formData = {
        name: document.getElementById('regName').value.trim(),
        phone: document.getElementById('regPhone').value.trim(),
        gender: document.getElementById('regGender').value,
        birthDate: document.getElementById('regBirthDate').value.trim(),
        grade: document.getElementById('regGrade').value,
        address: document.getElementById('regAddress').value.trim()
    };

    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData)
        });

        const result = await response.json();

        if (result.success) {
            // 📌 성공 시 예쁜 팝업 메시지 출력
            showToast(result.message || '가입 신청이 완료되었습니다.', true);
            
            // 1.5초 후 모달 닫기 및 폼 초기화
            setTimeout(() => {
                closeRegisterModal();
                document.getElementById('registerForm').reset();
            }, 1500);
        } else {
            // 📌 실패 시 에러 팝업 메시지 출력
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