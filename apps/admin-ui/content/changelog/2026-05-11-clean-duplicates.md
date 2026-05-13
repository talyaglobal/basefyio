---
date: 2026-05-11
slug: clean-duplicates
title: Clean Duplicates — Tekrar eden satirlari tek tikla temizle
kind: feature
summary: Bir veya daha fazla sutuna gore mukerrer kayitlari bul, on izleme yap, sonra binlerce/milyonlarca satiri saniyeler icinde sil.
---

## Ne yapar?

Buyuk import'lardan sonra mutlaka kalan: ayni `part_number`'a iki satir, ayni `email`'e ucuncu kayit. Eskiden SQL editorde `DELETE` cumlesi yazmak gerekirdi — riskli ve yavasti.

Yeni **Clean duplicates** butonu Table Editor sag ust kosesinde. Acan dialogda:

1. **Key columns** — Hangi sutun(lar)in es olmasi "duplicate" sayilsin? `part_number` secersin ya da `(brand, sku)` cifti gibi cogul. Bir sutunda NULL'lar birbiriyle es sayilir (DISTINCT ON semantigi).
2. **Search columns** — Cok genis tablolar icin (60+ sutun) anlik filtre.
3. **Preview count** — Hicbir sey silmeden, "su an kac satir silinecek?" sayisini gosterir. 1.500 → tikla → 1.500 satir silinir. 1.000'den fazla eslesirse `1.000+` der (counter capped). Once preview, sonra delete.
4. **Remove duplicates** — Onaylarsin, batched silme baslar. Her batch en fazla 8.000 satir. Bir grup icindeki en eski satir (Postgres internal `ctid`) korunur, kalanlar silinir.

## Performans

Onceki sezgisel implementasyon `WHERE EXISTS (SELECT ... ctid > t1.ctid ...)` self-join kullaniyordu. 1.5M satirda bu O(n^2) → 2.25 trilyon karsilastirma → 15s statement_timeout aninda patliyordu.

Yeni implementasyon **window function** kullaniyor:

```sql
DELETE FROM tablo
WHERE ctid IN (
  SELECT ctid FROM (
    SELECT ctid, ROW_NUMBER() OVER (PARTITION BY key_cols ORDER BY ctid) AS rn
    FROM tablo
  ) ranked
  WHERE rn > 1
  LIMIT 8000
)
```

Bu yaklasim O(n log n) — milyonlarca satirda saniye-dakika seviyesinde tamamlanir. Per-statement timeout bu islem icin 0'a (sinirsiz) cekilir cunku admin operasyonu.

## Onemli notlar

- **Geri alinamaz**. Silme kalicidir. Once `Preview count`, sonra `Remove duplicates`.
- **Foreign key kisitlari**: baska tablo bu satirlara FK ile bagliysa silme basarisiz olur — sistem hata mesaji gosterir, FK referanslarini cozmen gerekir.
- 16 milyon satir uzeri bir tek tiklamada silinmez — sistem "daha kaldi, tekrar bas" der.

## Test ettim mi?

`fleetpride_all_products` (1.5M satir) icinde `birim + i_stanbul_stok` cakismalarini birakti. Preview "1.243 satir silinecek". Click → 2 saniyede tamam. Yan tablonun row count'u sidebar'da otomatik guncellendi.
