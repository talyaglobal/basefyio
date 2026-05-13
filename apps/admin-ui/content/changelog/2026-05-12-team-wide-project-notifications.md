---
date: 2026-05-12
slug: team-wide-project-notifications
title: Proje bildirimleri artık tüm takım üyelerine
kind: feature
summary: Yeni proje açıldığında, silindiğinde veya geri alındığında — sadece ROOT'a değil, takımın bütün üyelerine bildirim düşer.
---

## Sorun

Realtime ilk sürümünde proje olayları için bildirim **sadece ROOT admin'lere** gidiyordu. Takıma davet edilmiş normal kullanıcılar, takım arkadaşı bir proje açtığında bunu görmek için sayfayı yenilemek zorunda kalıyordu.

## Çözüm

Proje olayları artık **takımın bütün üyelerine** Realtime üzerinden yayımlanıyor:

- **Yeni proje oluşturuldu** — *"Alice created 'AcmeShop'."*
- **Proje güncellendi** — *"Alice updated 'AcmeShop' (name, folder)."*
- **Proje silindi** — *"Alice moved 'AcmeShop' to trash."*
- **Proje geri alındı** — *"Alice restored 'AcmeShop'."*

Toast'a tıklayınca ilgili proje sayfasına gider.

## Tasarım kararları

- **Aktörün kendisi bildirim almaz.** Bir şey yaptığında zaten ne yaptığını biliyor; toast spam'i olmaz.
- **Sadece takım üyeleri görür.** Başka takımların projeleri görünmez — kanal yetkilendirmesi `team:{id}` ve `project:{id}` kanallarına abone olurken Prisma ile sahiplik doğrular.
- **Realtime kapatılırsa** kullanıcı sadece sayfayı yeniledikçe değişikliği görür; uygulama eskisine göre daha sessiz olur ama kırılmaz.

## Mevcut Realtime kapsamı özet

| Olay türü | Kimler bildirim alır |
|---|---|
| `feedback:created` | Tüm ROOT admin'ler |
| `feedback:status_changed / updated / deleted` | Feedback sahibi + ROOT admin'ler |
| `feedback_comment:comment_added` | Feedback sahibi + ROOT admin'ler |
| `project:created / updated / deleted / restored` | Takımın bütün üyeleri |
| `project_activity:activity_appended` | Projenin proje kanalına abone olanlar (Logs sayfası canlı akış için) |

## Test

İki normal kullanıcı (ROOT olmayan, aynı takımda) — biri proje oluştursun, diğerinin çanına 1 saniye içinde bildirim düşmeli.
