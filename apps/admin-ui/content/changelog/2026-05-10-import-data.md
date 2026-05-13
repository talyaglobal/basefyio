---
date: 2026-05-10
slug: import-data-wizard
title: Import Data — CSV ve Excel toplu yukleme sihirbazi
kind: feature
summary: Her projeye CSV/XLSX dosyalarini akilli bir sihirbazla toplu yukle. Otomatik sema tespiti, sutun esleme, conflict yonetimi, arkaplan isleme.
---

## Ne icin?

Kolay'da yeni bir tabloya veri yuklemek artik kolay. Excel'den / Postgres dump'tan / 3. parti tedarikciden gelen CSV-XLSX dosyalarini Table Editor uzerinden, hicbir SQL yazmadan icine atabiliyorsun.

## Nasil calisir?

Table Editor sag ust kosesindeki **Import Data** butonu sihirbazi acar. 4 adim:

1. **Upload** — Bir veya birden cok dosyayi siruksuyle birak. Tipler: `.csv`, `.tsv`, `.xlsx`. Her dosya boyutu ayri.
2. **Configure** — Sistem ilk binlerce satira bakip:
   - Header satirini bulur (degistirilebilir).
   - Sutun tiplerini tespit eder (text, integer, numeric, boolean, uuid, date, jsonb).
   - Hedef tabloyu sec: mevcut bir tabloya append / overwrite et, ya da yeni bir tablo yarat.
   - Sutun bazli esle: kaynak `Kategori` → hedef `kategori (text)`.
3. **Running** — BullMQ background job. Server-Sent Events ile canli progress: kac satir okundu, kac yazildi, kac atlandi, kac hatali oldu. Iptal edebilirsin.
4. **Done** — Ozet ekrani: toplam isle suresi, throughput, basari yuzdesi, hatali satirlarin CSV dosyasini indir.

## Conflict yonetimi (`On duplicate row`)

CSV'nin icinde mevcut tablonun anahtariyla cakisan satirlar varsa:

- **Skip — keep existing row**: var olani koru, yeni satiri atla. *"Eski veri kalsin."*
- **Update — overwrite existing row**: var olanin uzerine yaz. *"Yeni veri otoriter."*
- **Fail — error on conflict**: ilk cakismada tum aktarimi durdur. *"Hicbir cakisma istemiyorum."*

Skip / Update icin **conflict columns** sec — bu sutun(lar)in `UNIQUE` constraint'i olmali. Olmamis hatasi alirsan ya constrainti ekle, ya Fail moduna gec.

## Buyuk dosyalar icin presigned upload

50 MB'tan buyuk dosyalar dogrudan **MinIO'ya presigned PUT** ile yuklenir, platform-api uzerinden gecmez. Bu sayede 800 MB - 2 GB CSV'lar bile 502 / timeout almadan akar. Multi-file mode'da dosyalardan biri buyukse o tek dosya icin presigned, kucukler proxy uzerinden — otomatik karar.

## Hata satiri raporu

Her invalid satir (NULL constraint, type cast, vs.) bir bad-rows CSV'sine yazilir. Import bitince **Download error report** ile indirip, sebebini ayri kolonda goruyorsun.

## Performans optimizasyonu

- Worker batch INSERT yapar, batch boyutu 500 satir.
- Hata aldigi batch'leri **per-row retry**'a dusurur (class 22 / 23 SQL hatalari) — boylece tek bozuk satir 500'lu batch'i comple kaybetmez.
- Import bittikten sonra `ANALYZE schema.table` calistirir ki sidebar row count'u (`n_live_tup` tabanli) gercek sayiyla esit kalsin.

## Test ettim mi?

FleetPride catalog import: 20 dosya, toplam 1.5M satir, 850 MB. Single click, 12 dakika, sifir kayip.
