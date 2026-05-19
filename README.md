# 🎨 Mini r/place — Kubernetes Final Projesi

> Reddit r/place benzeri gerçek zamanlı işbirlikçi piksel canvas uygulaması.  
> Docker, Kubernetes (GKE), CI/CD pipeline ve tüm proje gereksinimleri uygulanmıştır.

---   c

## 📋 İçindekiler

1. [Proje Açıklaması](#proje-açıklaması)
2. [Uygulama Mimarisi](#uygulama-mimarisi)
3. [Kubernetes Mimarisi](#kubernetes-mimarisi)
4. [CI/CD Pipeline](#cicd-pipeline)
5. [Gereksinimler](#gereksinimler)
6. [Lokal Kurulum (Docker Compose)](#lokal-kurulum-docker-compose)
7. [GKE Kurulum Kılavuzu](#gke-kurulum-kılavuzu)
8. [Deployment, Service, PV/PVC](#deployment-service-pvpvc)
9. [NetworkPolicy](#networkpolicy)
10. [Scaling — HPA](#scaling--hpa)
11. [Rolling Update & Rollback](#rolling-update--rollback)
12. [GitHub Secrets](#github-secrets)
13. [Proje Yapısı](#proje-yapısı)

---

## Proje Açıklaması

Mini r/place, kullanıcıların 100×100'lük bir piksel canvas üzerinde birlikte çizim yaptığı gerçek zamanlı bir web uygulamasıdır. Her kullanıcı 5 saniyede bir piksel yerleştirebilir; değişiklikler WebSocket aracılığıyla tüm bağlı kullanıcılara anında iletilir. Canvas durumu PostgreSQL veritabanında kalıcı olarak saklanır.

**Özellikler:**
- 🎨 32 renkli Reddit r/place paleti
- ⚡ WebSocket ile gerçek zamanlı güncelleme
- 🗺️ Zoom, pan ve mini harita desteği
- ⏱️ 5 saniyelik cooldown sistemi
- 📊 Online kullanıcı ve piksel sayacı
- 💾 PostgreSQL ile kalıcı veri saklama

---

## Uygulama Mimarisi

```
┌─────────────────────────────────────────────────┐
│                  Kullanıcı Tarayıcısı            │
│  HTML Canvas + WebSocket + REST API              │
└───────────────────────┬─────────────────────────┘
                        │ HTTP / WebSocket
                        ▼
┌─────────────────────────────────────────────────┐
│           Frontend (nginx:1.25-alpine)           │
│  - Statik dosyaları serve eder                   │
│  - /api/* → backend-service:3001 proxy           │
│  - /ws    → backend-service:3001 ws proxy        │
└───────────────────────┬─────────────────────────┘
                        │ Internal HTTP
                        ▼
┌─────────────────────────────────────────────────┐
│           Backend (Node.js 20)                   │
│  - Express REST API                              │
│  - WebSocket Server (ws library)                 │
│  - Rate limiting (IP bazlı)                      │
│  - In-memory canvas cache                        │
└───────────────────────┬─────────────────────────┘
                        │ TCP 5432
                        ▼
┌─────────────────────────────────────────────────┐
│           PostgreSQL 15                          │
│  - pixels tablosu (x, y, color, placed_at)       │
│  - PersistentVolumeClaim ile kalıcı depolama     │
└─────────────────────────────────────────────────┘
```

### REST API Endpoints

| Method | Path          | Açıklama                        |
|--------|---------------|---------------------------------|
| GET    | `/health`     | Sağlık kontrolü                 |
| GET    | `/api/canvas` | Tüm canvas verisini döner       |
| POST   | `/api/pixel`  | Piksel yerleştirir              |
| GET    | `/api/stats`  | Online kullanıcı, versiyon vb.  |
| WS     | `/ws`         | Gerçek zamanlı piksel stream    |

---

## Kubernetes Mimarisi

```
                    ┌────────────────────────────┐
                    │       r-place Namespace     │
                    │                             │
  Internet ─────►  │  [frontend-service]          │
                    │  LoadBalancer :80            │
                    │         │                   │
                    │         ▼                   │
                    │  [frontend Deployment]       │
                    │  replica: 2                 │
                    │  nginx pod × 2              │
                    │         │                   │
                    │  NetworkPolicy ✓            │
                    │         ▼                   │
                    │  [backend-service]           │
                    │  ClusterIP :3001            │
                    │         │                   │
                    │         ▼                   │
                    │  [backend Deployment]        │
                    │  replica: 2 (HPA: 2-10)     │
                    │  node pod × 2               │
                    │         │                   │
                    │  NetworkPolicy ✓            │
                    │         ▼                   │
                    │  [postgres-service]          │
                    │  ClusterIP :5432            │
                    │         │                   │
                    │         ▼                   │
                    │  [postgres Deployment]       │
                    │  replica: 1                 │
                    │         │                   │
                    │         ▼                   │
                    │  [PersistentVolumeClaim]     │
                    │  2Gi SSD                    │
                    └────────────────────────────┘
```

### Kubernetes Bileşenleri

| Bileşen                  | Tip               | Açıklama                                |
|--------------------------|-------------------|-----------------------------------------|
| `namespace.yaml`         | Namespace         | Tüm kaynaklar `r-place` ns'de izole     |
| `postgres-secret.yaml`   | Secret            | DB kimlik bilgileri şifreli saklanır    |
| `postgres-pvc.yaml`      | PVC               | 2Gi SSD kalıcı veri                     |
| `postgres-deployment.yaml`| Deployment       | PostgreSQL, Recreate stratejisi         |
| `postgres-service.yaml`  | Service/ClusterIP | Yalnızca backend erişebilir             |
| `backend-deployment.yaml`| Deployment        | RollingUpdate, 2 replica               |
| `backend-service.yaml`   | Service/ClusterIP | Yalnızca frontend erişebilir            |
| `frontend-deployment.yaml`| Deployment       | RollingUpdate, 2 replica               |
| `frontend-service.yaml`  | Service/LB        | Dış dünyaya açık, external IP          |
| `network-policy.yaml`    | NetworkPolicy     | Katmanlı trafik kısıtlaması            |
| `hpa.yaml`               | HPA               | CPU %50 → 2-10 replica otomatik scale  |

---

## CI/CD Pipeline

```
┌──────────┐   push    ┌─────────────────────────────────────────────┐
│  GitHub  │ ────────► │           GitHub Actions Workflow            │
│  main    │           │                                             │
└──────────┘           │  ┌──────────┐  ┌────────────────┐           │
                       │  │  1. Test │  │ 2. Build&Push  │           │
                       │  │  - lint  │─►│ - docker build │           │
                       │  │  - k8s   │  │ - docker push  │           │
                       │  │  dry-run │  │   (sha tag)    │           │
                       │  └──────────┘  └───────┬────────┘           │
                       │                        │                    │
                       │                        ▼                    │
                       │               ┌────────────────┐            │
                       │               │  3. Deploy GKE  │           │
                       │               │  - kubectl apply│           │
                       │               │  - rollout wait │           │
                       │               └────────────────┘            │
                       └─────────────────────────────────────────────┘
```

**Workflow adımları:**
1. **Test**: Node.js syntax check, K8s manifest dry-run
2. **Build & Push**: Docker Hub'a `sha` ve `latest` tag ile push
3. **Deploy**: GKE'ye `kubectl apply`, rollout status bekleme

---

## Gereksinimler

### Lokal Geliştirme
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) ≥ 24
- [docker-compose](https://docs.docker.com/compose/) ≥ 2

### GKE Deployment
- [Google Cloud SDK](https://cloud.google.com/sdk)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)
- GCP projesi ve GKE kümesi
- Docker Hub hesabı

---

## Lokal Kurulum (Docker Compose)

```bash
# 1. Repoyu klonla
git clone https://github.com/KULLANICI_ADI/r-place.git
cd r-place

# 2. Tüm servisleri başlat
docker compose up --build

# 3. Tarayıcıda aç
# http://localhost
```

**Servis portları:**

| Servis    | Port  |
|-----------|-------|
| Frontend  | 80    |
| Backend   | 3001  |
| PostgreSQL| 5432  |

---

## GKE Kurulum Kılavuzu

### 1. GKE Kümesi Oluştur

```bash
# GCP projesini ayarla
gcloud config set project YOUR_PROJECT_ID

# GKE kümesi oluştur
gcloud container clusters create rplace-cluster \
  --zone europe-west1-b \
  --num-nodes 3 \
  --machine-type e2-medium \
  --enable-autoscaling \
  --min-nodes 2 \
  --max-nodes 5

# kubectl bağlantısı
gcloud container clusters get-credentials rplace-cluster \
  --zone europe-west1-b
```

### 2. Docker Image'larını Build & Push

```bash
# Docker Hub'a login
docker login

# Backend
docker build -t YOUR_DOCKERHUB/rplace-backend:latest ./backend
docker push YOUR_DOCKERHUB/rplace-backend:latest

# Frontend
docker build -t YOUR_DOCKERHUB/rplace-frontend:latest ./frontend
docker push YOUR_DOCKERHUB/rplace-frontend:latest
```

### 3. K8s Manifests'lerdeki Image Adını Güncelle

```bash
# YOUR_DOCKERHUB yerine kendi Docker Hub kullanıcı adını yaz
sed -i 's/DOCKER_USERNAME/YOUR_DOCKERHUB/g' k8s/backend-deployment.yaml
sed -i 's/DOCKER_USERNAME/YOUR_DOCKERHUB/g' k8s/frontend-deployment.yaml
```

### 4. Tüm Kaynakları Deploy Et

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/postgres-secret.yaml
kubectl apply -f k8s/postgres-pvc.yaml
kubectl apply -f k8s/postgres-deployment.yaml
kubectl apply -f k8s/postgres-service.yaml

# PostgreSQL hazır olana kadar bekle
kubectl rollout status deployment/postgres -n r-place

kubectl apply -f k8s/backend-deployment.yaml
kubectl apply -f k8s/backend-service.yaml
kubectl rollout status deployment/backend -n r-place

kubectl apply -f k8s/frontend-deployment.yaml
kubectl apply -f k8s/frontend-service.yaml
kubectl rollout status deployment/frontend -n r-place

kubectl apply -f k8s/network-policy.yaml
kubectl apply -f k8s/hpa.yaml
```

### 5. External IP'yi Al

```bash
kubectl get svc frontend-service -n r-place
# EXTERNAL-IP sütunundaki IP adresini tarayıcıda aç
```

---

## Deployment, Service, PV/PVC

### Deployment Stratejisi

Her Deployment `RollingUpdate` stratejisi kullanır:

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 1   # En fazla 1 pod kapalı olabilir
    maxSurge: 1         # En fazla 1 ekstra pod çalışabilir
```

PostgreSQL `Recreate` kullanır (PVC tek pod'a mount edilebilir).

### PersistentVolumeClaim

```bash
# PVC durumunu kontrol et
kubectl get pvc -n r-place

# Beklenen çıktı:
# NAME           STATUS   VOLUME   CAPACITY   STORAGECLASS
# postgres-pvc   Bound    ...      2Gi        standard-rwo
```

PVC sayesinde PostgreSQL pod'u yeniden başlatılsa bile canvas verisi kaybolmaz.

---

## NetworkPolicy

Uygulamada dört katmanlı NetworkPolicy uygulanmaktadır:

```bash
# Policies'i listele
kubectl get networkpolicy -n r-place

# Çıktı:
# allow-external-to-frontend   (Dışarıdan frontend:80)
# allow-frontend-to-backend    (Frontend→Backend:3001)
# allow-backend-to-postgres    (Backend→Postgres:5432)
# allow-all-egress             (Tüm podlar dışarıya çıkabilir)
```

**Kural özeti:**
- ✅ İnternet → Frontend (port 80)
- ✅ Frontend → Backend (port 3001)
- ✅ Backend → PostgreSQL (port 5432)
- ❌ İnternet → Backend (yasak)
- ❌ İnternet → PostgreSQL (yasak)
- ❌ Frontend → PostgreSQL (yasak)

---

## Scaling — HPA

### Otomatik Ölçekleme (HPA)

```bash
# HPA durumunu izle
kubectl get hpa backend-hpa -n r-place -w

# Manuel ölçekleme (demo için)
kubectl scale deployment backend --replicas=5 -n r-place

# Durumu izle
kubectl get pods -n r-place -w
```

HPA kuralları:
- **Min:** 2 replica
- **Max:** 10 replica
- **Tetikleyici:** CPU > %50 → scale up, CPU < %50 → scale down

---

## Rolling Update & Rollback

### Rolling Update

```bash
# Yeni image versiyonu deploy et
kubectl set image deployment/backend \
  backend=YOUR_DOCKERHUB/rplace-backend:v2.0.0 \
  -n r-place

# Update ilerlemesini izle
kubectl rollout status deployment/backend -n r-place

# Update geçmişini görüntüle
kubectl rollout history deployment/backend -n r-place
```

### Rollback

```bash
# Son versiyona geri dön
kubectl rollout undo deployment/backend -n r-place

# Belirli bir versiyona geri dön
kubectl rollout undo deployment/backend --to-revision=1 -n r-place

# Durumu kontrol et
kubectl rollout status deployment/backend -n r-place
```

### Hızlı Komutlar

```bash
# Tüm pod'ları listele
kubectl get pods -n r-place

# Pod loglarını görüntüle
kubectl logs -f deployment/backend -n r-place

# Pod detayları
kubectl describe pod -l app=backend -n r-place

# Tüm kaynakları sil (cleanup)
kubectl delete namespace r-place
```

---

## GitHub Secrets

CI/CD pipeline için aşağıdaki secret'ları GitHub repository → Settings → Secrets → Actions'a ekleyin:

| Secret            | Açıklama                         |
|-------------------|----------------------------------|
| `DOCKER_USERNAME` | Docker Hub kullanıcı adı         |
| `DOCKER_PASSWORD` | Docker Hub token/şifre           |
| `GCP_SA_KEY`      | GCP Service Account JSON (base64)|
| `GCP_PROJECT_ID`  | Google Cloud Proje ID            |
| `GKE_CLUSTER`     | GKE küme adı                     |
| `GKE_ZONE`        | GKE zone (örn: europe-west1-b)   |

**GCP Service Account oluşturma:**

```bash
# Service Account oluştur
gcloud iam service-accounts create github-actions \
  --display-name="GitHub Actions"

# Gerekli rolleri ata
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:github-actions@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/container.developer"

# Key oluştur ve base64'e çevir
gcloud iam service-accounts keys create key.json \
  --iam-account=github-actions@YOUR_PROJECT_ID.iam.gserviceaccount.com

cat key.json | base64 | tr -d '\n'
# Çıktıyı GCP_SA_KEY secret'ına yapıştır
```

---

## Proje Yapısı

```
r-place/
├── frontend/                    # nginx + Vanilla JS frontend
│   ├── Dockerfile
│   ├── nginx.conf.template      # Envsubst destekli nginx config
│   └── public/
│       ├── index.html
│       ├── style.css
│       └── app.js               # Canvas, WebSocket, zoom/pan
│
├── backend/                     # Node.js API + WebSocket server
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js                # Express + ws + rate limiting
│   └── db.js                    # PostgreSQL bağlantısı
│
├── k8s/                         # Kubernetes manifests
│   ├── namespace.yaml
│   ├── postgres-secret.yaml
│   ├── postgres-pvc.yaml        # 2Gi PersistentVolumeClaim
│   ├── postgres-deployment.yaml
│   ├── postgres-service.yaml
│   ├── backend-deployment.yaml  # RollingUpdate strategy
│   ├── backend-service.yaml
│   ├── frontend-deployment.yaml
│   ├── frontend-service.yaml    # LoadBalancer (external IP)
│   ├── network-policy.yaml      # Katmanlı trafik kısıtlaması
│   └── hpa.yaml                 # HPA: CPU %50 → 2-10 replica
│
├── .github/workflows/
│   └── ci-cd.yaml               # Test → Build → Deploy pipeline
│
├── docker-compose.yml           # Lokal geliştirme ortamı
└── README.md                    # Bu dosya
```

---

## Teknoloji Stack

| Katman       | Teknoloji               |
|--------------|-------------------------|
| Frontend     | Vanilla HTML/CSS/JS     |
| Web Server   | nginx 1.25              |
| Backend      | Node.js 20, Express 4   |
| WebSocket    | ws library              |
| Database     | PostgreSQL 15           |
| Container    | Docker                  |
| Orchestration| Kubernetes (GKE)        |
| CI/CD        | GitHub Actions          |
| Registry     | Docker Hub              |
| Cloud        | Google Cloud Platform   |
