# حرف في الهوا ✍️ | Harf fil Hawa

**اكتب حروف عربية أو إنجليزية في الهوا بإصبعك قدام الكاميرا. الموقع يرسمها بخط ذهبي على شكل خط القلم، ويتعرّف على كل حرف بشبكة عصبية متدرّبة على خط يد حقيقي، ويجمع الحروف لين تصير كلمة.**

**Write Arabic or English letters in the air with your finger in front of a webcam. The page draws them with a calligraphy-style brush, recognizes each letter with a CNN trained on real handwriting, and builds them into words.**

### [▶ جرّبها مباشرة | Try it live](https://marwathebest.github.io/harf-fil-hawa/)

![Harf fil Hawa: the letter ب drawn in the air and recognized, building the word باب](docs/screenshot.jpg)

## طريقة الاستخدام | How to use

1. اضغط **شغّل الكاميرا**، أو **جرّب بالماوس** لو ما عندك كاميرا. وزر **«عربي ⇄ EN»** يبدّل بين العربي والإنجليزي.
2. **قرّب السبابة من الإبهام** عشان يبدأ الرسم، و**بعّدهم** عشان يوقف.
3. اكتب الحرف بشكله المنفصل. النقاط تكون بنقرة سريعة.
4. وقّف ثانية، فيطلع الحرف وينضاف للكلمة. لو قرأه غلط، اختر الحرف الصح والموقع **يتعلّم خطك**.
5. **غلطت؟** ✋ افتح كفّك قدام الكاميرا ثانية، فتنمسح اللوحة، وينشال الحرف من الكلمة لو كان توه انقرأ.
6. **الأزرار باليد:** ⏳ وقّف الدائرة فوق أي زر ثانية وحدة فينضغط، يعني ما تحتاج ماوس أبداً.
7. **حفظ صورة** يطلّع لك الكلمة كبوستر PNG.

## كيف يشتغل | How it works

| الجزء | Part | |
|---|---|---|
| تتبّع اليد | Hand tracking | [MediaPipe Hand Landmarker](https://developers.google.com/mediapipe/solutions/vision/hand_landmarker) داخل المتصفح (WebAssembly + GPU). يمر على ٢١ نقطة في اليد مع كل فريم |
| بدء الرسم | Pinch | المسافة بين طرف الإبهام وطرف السبابة، مقسومة على حجم اليد. وفيه هامش بين بداية الرسم ونهايته عشان ما يرتجف |
| الإيماءات | Gestures | الكف المفتوح يمسح (الأصابع الأربعة ممدودة والإبهام بعيد)، والوقوف فوق زر يضغطه (dwell click) |
| تنعيم الحركة | Smoothing | [One Euro Filter](https://gery.casiez.net/1euro/) يشيل رجفة اليد، ويخلي الحركة السريعة سريعة |
| الفرشاة | Brush | قلم مسطّح بزاوية ٣٥°، يعرض ويرفع حسب اتجاه الحركة زي قلم الخط العربي |
| التعرّف | Recognition | شبكة **CNN** صغيرة (٥ طبقات conv) تشتغل داخل المتصفح بـ JavaScript بدون أي مكتبة. متدرّبة على [AHCD](https://github.com/mloey/Arabic-Handwritten-Characters-Dataset) (١٦٨٠٠ حرف عربي بخط ٦٠ شخص) و [EMNIST Letters](https://huggingface.co/datasets/tanganke/emnist_letters) (١٢٤٨٠٠ حرف إنجليزي). قبل التدريب وقبل القراءة يتوحّد شكل الحرف بنفس الخطوات: قص، توسيط، تنحيف لبكسل واحد، وسُمك ثابت. وأثناء التدريب تنضاف تشويهات عشوائية تشبه رجفة اليد في الهوا |
| التعلّم | Learning | لما تصحّح حرف، تنحفظ كتابتك كقالب جديد في المتصفح (localStorage) |

**الدقة | Accuracy:** على حروف ناس ما شافهم النموذج أبداً: العربي **٨٤٪** (28 حرف)، والإنجليزي **٩٠٪** (26 حرف). ولما تصحّح حرف، كتابتك تنحفظ وتنخلط مع رأي الشبكة، فيتحسّن مع خطك. التدريب من جديد: `python tools/prep.py data arrays` وبعدها `python tools/train.py ar arrays models 30` (CPU، تقريباً ١٥ دقيقة).

**الخصوصية | Privacy:** كل المعالجة تصير داخل المتصفح، وما ينرسل أي فيديو أو صورة لأي سيرفر.

## التشغيل محلياً | Run locally

```bash
python -m http.server 8000
```

وبعدها افتح `http://localhost:8000`. الكاميرا ما تشتغل إلا على `localhost` أو `https`.

## الملفات | Files

| | |
|---|---|
| `index.html` · `css/style.css` | الواجهة (RTL) |
| `js/app.js` | الكاميرا، تتبّع اليد، الرسم، والتعلّم من التصحيح |
| `js/cnn.js` | تجهيز الكتابة وتشغيل الشبكة العصبية |
| `js/recognizer.js` | مقارنة الأشكال: لكتابات المستخدم المحفوظة، وطريقة احتياطية |
| `models/` | أوزان الشبكة (int8)، العربي والإنجليزي |
| `tools/prep.py` · `tools/train.py` | تجهيز البيانات وتدريب الشبكة بـ PyTorch |
| `tools/accuracy.html` | اختبار الدقة على خطوط ما تعلّم منها المتعرّف |

## التقنيات | Tech

JavaScript (ES modules) · Canvas 2D · MediaPipe Tasks Vision · PyTorch (training) · CNN inference in plain JS · Computer vision (thinning, distance transform, chamfer matching) · بدون أي framework أو build step

---

Made by [Marwah Abdullah Sabei](https://github.com/marwathebest)
