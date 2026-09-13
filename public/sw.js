// public/sw.js
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// 크롬이 PWA 설치를 허용하기 위해 반드시 필요한 fetch 이벤트 처리
self.addEventListener('fetch', (event) => {
    event.respondWith(
        fetch(event.request).catch(() => {
            // 오프라인 상태일 때 등의 예외 처리 (필요시 리소스 반환)
            return caches.match(event.request);
        })
    );
});

// 알림 클릭 시 해당 웹페이지 탭으로 이동
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            if (clientList.length > 0) {
                return clientList[0].focus();
            }
            return clients.openWindow('/');
        })
    );
});