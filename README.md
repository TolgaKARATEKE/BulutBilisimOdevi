# R/Place - Bulut Bilişim Projesi

Bu proje, Reddit'in r/place etkinliğinden esinlenerek geliştirdiğimiz gerçek zamanlı bir ortak tuval (canvas) uygulamasıdır. Kullanıcılar bağlandıkları web sayfası üzerinden anlık olarak piksellerin rengini değiştirebilmektedir. Tüm sistem Kubernetes ortamında çalışacak şekilde mikroservis mimarisiyle tasarlanmıştır.

## Proje Mimarisi

Projemizi üç temel parçaya böldük:
- Frontend: Kullanıcı arayüzü kısmı. HTML, CSS ve JavaScript kullanarak basit bir arayüz tasarladık ve bunu Nginx üzerinden dışarıya açtık.
- Backend: REST API ve WebSocket kısımlarını Node.js ve Express kullanarak yazdık. Kullanıcıların koyduğu pikselleri veritabanına yazıyor ve anlık olarak diğer tüm kullanıcılara WebSocket üzerinden iletiyor. Ayrıca arka arkaya spam yapılmasın diye belli bir saniye bekleme süresi (cooldown) kontrolü ekledik.
- Database: Uygulamanın veritabanı olarak PostgreSQL kullandık.

## Kubernetes ve Sistem Altyapısı

Sistemin Kubernetes tarafında esnek ve güvenli çalışması için k8s klasörü altına gerekli YAML dosyalarını oluşturduk:
- İzolasyon için kendi r-place namespace'imizi kullandık.
- Uygulamanın yoğunluğa göre (CPU kullanımına bağlı olarak) otomatik büyümesi için HPA (Horizontal Pod Autoscaler) ekledik. Backend sunucumuz yük altında 10 poda kadar çıkabiliyor.
- Veritabanındaki piksellerin pod yeniden başlatıldığında silinmemesi için PVC (Persistent Volume Claim) ile kalıcı disk tanımladık.
- Sistemin ağ güvenliği için NetworkPolicy kuralları yazdık. Buna göre dışarıdan sadece frontend erişilebiliyor; frontend sadece backend'e, backend ise sadece veritabanına bağlanabiliyor.
- CI/CD süreçleri için GitHub Actions kullandık. Koda yeni bir özellik ekleyip pushladığımızda sistem bunu otomatik test edip Docker imajı olarak DockerHub'a yüklüyor ve doğrudan Google Kubernetes Engine (GKE) ortamına kendi kendine deploy ediyor.

## Nasıl Çalıştırılır?

### Lokal Ortamda (Docker Compose ile)
Projeyi bilgisayarınızda test etmek isterseniz ana dizinde terminali açıp şu komutu çalıştırmanız yeterlidir:
```bash
docker-compose up --build -d
```
Ardından tarayıcınızdan http://localhost:8080 adresinden uygulamaya girebilirsiniz.

### Kubernetes Ortamında
Uygulamayı sıfırdan bir Kubernetes cluster'ına kurmak isterseniz k8s klasöründeki dosyaları aşağıdaki sırayla çalıştırmanız gerekiyor:

```bash
# 1. Namespace ve Veritabanı
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/postgres-secret.yaml
kubectl apply -f k8s/postgres-pvc.yaml
kubectl apply -f k8s/postgres-deployment.yaml
kubectl apply -f k8s/postgres-service.yaml

# 2. Backend
kubectl apply -f k8s/backend-deployment.yaml
kubectl apply -f k8s/backend-service.yaml

# 3. Frontend
kubectl apply -f k8s/frontend-deployment.yaml
kubectl apply -f k8s/frontend-service.yaml

# 4. Güvenlik ve HPA
kubectl apply -f k8s/network-policy.yaml
kubectl apply -f k8s/hpa.yaml
```

## API Kullanımı

Sistemin sağlık durumunu ve genel verileri çekmek için yazdığımız basit REST API'lar şunlardır:

- GET /health : Sistem çalışıyor mu diye (readiness/liveness) kontrol etmek için.
- GET /api/stats : O an kaç kişi bağlı ve toplam kaç piksel koyulmuş onu döndürür.
- GET /api/canvas : Tuvalin o anki halini JSON formatında verir.
- POST /api/pixel : Yeni piksel koymak için x, y ve renk bilgilerini yolladığımız yer.

Not: Gerçek zamanlı olarak kullanıcıların koyduğu renklerin diğerlerinde anlık gözükmesi WebSocket üzerinden çalışmaktadır.
