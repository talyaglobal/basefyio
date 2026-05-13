---
date: 2026-05-12
slug: realtime-notifications
title: Anlık bildirimler artık çalışıyor
kind: feature
summary: 15 saniye bekleme yok — feedback olayları artık tarayıcına anlık düşüyor.
---

## Ne değişti?

Eskiden bir kullanıcı feedback gönderdiğinde, başkalarının bunu görmesi için **15 saniyelik polling döngüsü** beklemesi gerekiyordu. Bu süre boyunca tarayıcı, sunucuya "yeni bir şey var mı?" diye sorup duruyordu. Şimdi sunucu, olay olduğu anda **tek taraflı** olarak tarayıcıya bildiriyor.

Sonuç: feedback gönderildiği an ROOT admin'lerin bildirim çanı yanıyor. Ortalama gecikme 15 sn → 200 ms (yaklaşık 75× daha hızlı).

## Hangi olaylar artık anlık?

- **Yeni feedback gönderildi** — ROOT admin'lere düşer.
- **Feedback statüsü değiştirildi** — feedback sahibi + ROOT admin'lere.
- **Feedback güncellendi / silindi** — aynı alıcı listesi.
- **Yorum eklendi** — feedback sahibi + ROOT admin'lere; yorumun ilk 200 karakteri bildirim mesajında.

## Nasıl test edersin?

1. İki ayrı tarayıcı sekmesi aç, biri ROOT, biri normal kullanıcı.
2. Normal kullanıcı sekmesinden Feedback butonu → bir şey yaz → Send.
3. ROOT sekmesinde **1 saniyeden kısa** sürede çan kırmızıya döner, toast çıkar: *"New feedback submitted — TestUser (test@x.com) submitted 'Bug raporu'."*

DevTools'ta `realtime/stream` isteğini açıp **EventStream** sekmesinden olayların geldiğini canlı görebilirsin.

## Acil durum kapatma

Bir sorun çıkarsa redeploy gerektirmeden devre dışı bırakabilirsin:

- Platform-api container env: `KB_REALTIME_DISABLE=1` → sunucu olay yayımlamaz.
- Admin-ui container env: `NEXT_PUBLIC_KB_REALTIME_DISABLE=1` → tarayıcı abone olmaz.
