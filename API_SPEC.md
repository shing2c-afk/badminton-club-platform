# 배드민턴 매칭 시스템 소켓 규격서 (Socket API Specification)

---

## 1. 서버 ➔ 프론트엔드 (Server to Client: 상태 동기화 및 알림)

클라이언트가 접속 중이거나 데이터 변화가 생겼을 때 서버가 전체 화면을 갱신하기 위해 뿌려주는 데이터입니다.

| 이벤트 이름 | 전달 데이터 (Payload) | 설명 |
| :--- | :--- | :--- |
| `stateUpdated` | `{ config, courtsData, gameQueue, nantaQueue, notifications }` | 전체 시스템 상태(설정, 코트 현황, 대기열, 알림) 실시간 동기화 |
| `courtClearedNotice` | `{ courtId, category, message }` | 관리자에 의해 특정 코트가 강제 종료(비워짐)되었을 때 알림 |
| `alertMessage` | `string (메시지 텍스트)` | 중복 입장 금지 등의 경고 팝업 표시 |
| `confirmCrossSlot` | `{ type, userId, user }` | 게임/난타 교차 대기 시 확인(컨펌) 요구 |
| `confirmFirstSlot` | `{ type, userId, user }` | 최초 방 개설 시 확인 요구 |

---

## 2. 프론트엔드 ➔ 서버 (Client to Server: 유저 및 관리자 액션)

사용자나 관리자가 화면에서 버튼을 누르거나 액션을 취했을 때 서버로 요청을 보내는 통신 규격입니다.

| 이벤트 이름 | 전달 데이터 (Payload) | 설명 |
| :--- | :--- | :--- |
| `registerUserSession` | `username (string)` | 로그인한 사용자의 세션을 소켓에 등록 |
| `verifyAdminPassword` | `inputPw (string), callback (function)` | 관리자 비밀번호 검증 요청 |
| `updateConfig` | `{ ENTRY_TIMEOUT_SEC, NANTA_COURT_LIMIT_SEC, ADMIN_PASSWORD }` | 시스템 환경 설정 변경 |
| `updateCourtsConfig` | `Array (CourtsConfig Data)` | 전체 코트 구성 및 타입 설정 변경 |
| `endNantaCourt` | `{ courtId: number, side: 'A' 또는 'B' }` | 특정 난타 코트의 A면 또는 B면 수동 종료 요청 |
| `createSlot` | `{ type: 'game'\|'nanta', userId, user }` | 새로운 대기 방 개설 요청 |
| `forceCreateSlot` | `{ type: 'game'\|'nanta', userId, user }` | 교차 방 개설 등의 경고를 무시하고 강제 개설 |
| `joinPlayer` | `{ type: 'game'\|'nanta', slotId, index, name }` | 기존 대기 방의 빈 자리에 참가 |
| `exitPlayer` | `{ type: 'game'\|'nanta', slotId, index }` | 대기 방에서 나가기 (본인 자리 비우기) |
| `enterCourtFromSlot` | `{ type: 'game'\|'nanta', slotId }` | 대기 방 정원이 찼을 때 코트로 입장 처리 |

---

## 3. 주요 데이터 구조 (Data Schemas) 참조

서버가 관리하고 프론트엔드가 공유하는 핵심 데이터의 형태입니다.

### 🏀 courtsData (코트 배열 구조)
* **게임 코트:** `{ id: number, type: 'game', isEmpty: boolean, players: string, note: string }`
* **난타 코트:** `{ id: number, type: 'nanta', sideA: { isEmpty, players, startTime, remainingSeconds }, sideB: { isEmpty, players, startTime, remainingSeconds }, note: string }`
* **레슨 코트:** `{ id: number, type: 'lesson', isEmpty: boolean, players: string, note: string }`

### 📋 gameQueue / nantaQueue (대기열 방 구조)
* `{ id: string, type: string, players: Array<string>, userIds: Array<string>, createdAt: number, fullAt: number|null, remainingSeconds: number|null }`

---

## 💡 앞으로의 작업 원칙
1. **서버 우선 원칙:** 새로운 기능 추가 시, 프론트엔드 코드를 먼저 작성하기보다 **서버 이벤트(`socket.on`)와 데이터 이름을 먼저 `server.js`에 정의**합니다.
2. **규격 일치화:** 프론트엔드(`ui.js`)에서는 정의된 규격에 맞춰 정확히 객체 형태로 데이터를 포장해 `socket.emit`을 호출합니다.