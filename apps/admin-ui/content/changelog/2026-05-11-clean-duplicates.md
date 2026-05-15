---
date: 2026-05-11
slug: clean-duplicates
title: Tekrar eden satirlari tek tikla temizleyin
kind: feature
summary: Tablonuzdaki mukerrer kayitlari bulun, kacinin silinecegini gorun, tek tikla temizleyin.
---

Toplu veri yukledikten sonra tabloda ayni kayittan birden fazla kalabiliyor. Ayni e-posta adresi iki kere, ayni urun kodu uc kere... Bunlari elle temizlemek hem zahmetli hem riskli.

Artik Table Editor'deki **Clean duplicates** butonuyla tek tikla halledebilirsiniz.

## Nasil kullanilir?

1. **Hangi sutunlara gore?** — Ornegin `email` sutununu secin. Ayni e-postaya sahip satirlar tekrar sayilir. Birden fazla sutun da secebilirsiniz, mesela `marka + urun_kodu` birlikte.

2. **Once sayiyi gorun** — "Kac satir silinecek?" sorusunun cevabini, hicbir sey silmeden once gorursunuz.

3. **Temizleyin** — Onaylayin, tekrar eden satirlar silinsin. Her gruptaki en eski kayit korunur, digerileri kaldirilir.

## Bilmeniz gerekenler

- **Geri alinamaz.** Silinen satirlar geri gelmez. Bu yuzden once mutlaka on izleme yapin.
- **Cok hizli.** Milyonlarca satirda bile saniyeler icinde tamamlanir.
- Baska tablolarla baglantili satirlar varsa (foreign key), sistem sizi uyarir — once o baglantilari cozmeniz gerekir.
