# 宝丽来显影盒 · 设计依据与实测数据

事实核对 + 从参考图提取的设计参数。这些数据已经落进 `src/` 的实现里。

## 一、i-Type 相纸尺寸（多来源一致）

| 项目 | 数值 |
|---|---|
| 相纸外形 | **107.5 × 88.5 mm**（4.23 × 3.48 in） |
| 成像区 | **79 × 79 mm**（居中偏上，下边白边最宽） |
| 每包张数 | 8 张 |
| 卡匣外形 | **约 114 × 94 × 20 mm**（4.5 × 3.7 × 0.8 in） |
| ISO | 640（i-Type 无电池，与 600 不同） |

由外形反推的白边（建模用）：
- 左右各 `(88.5 − 79) / 2 =` **4.75 mm**
- 上边 ≈ **4.5 mm**
- 下边 ≈ **24.75 mm**（经典宝丽来宽带在下，即握持处）

## 二、从官方包装实测的色彩（已写入 `src/core.js` 的 `COL`）

### 正面三条竖色带（约占正面宽度的 32%）
采样自官方 i-Type 包装正面，从 `x=0.085W` 起：

| 色 | 值 |
|---|---|
| 红 | `#D65649` |
| 橙 | `#EF8C49` |
| 黄 | `#FFC857` |

### 书脊五色块（约占侧面高度 62%）
| 色 | 值 |
|---|---|
| 蓝 | `#5E94D0` |
| 绿 | `#96C253` |
| 黄 | `#FABD31` |
| 橙 | `#E86B3F` |
| 红 | `#D1372D` |

### 其他
- 壳体白：`#F0F0EC`（冷白纸感，不是纯白）
- 真宝丽来白边框实际偏冷：`#EDF1F4`
- 红按钮：`#D8202A`，哑光磨砂

## 三、保留的参考图

- `crop_i2_button.jpg` — i-2 红色按钮特写：鲜红、哑光、微凸约 1mm、外圈一道窄倒角凹槽
- `crop_lugs.jpg` — SX-70 挂耳特写：嵌进机身的耳朵，中间扁孔，背带直接穿过
- `image.png` — 官方 i-Type 包装实拍（正面排版依据：三条竖色带 + 白色大字压在色带上 + 底部黑色 polaroid 字标）

> 其余下载的参考图（SX-70 各角度、官方 i-2 render 等）在量取完参数后已清理，参数见上文。

## 四、成品设计参数（`src/core.js` 的 `DIM`）

| 项目 | 值 |
|---|---|
| 盒体 | 9.8 × 11.8 × 2.4 cm |
| 壁厚 | 0.18 cm |
| 顶面门留边 | 左 1.50 / 右 0.50 / 前 0.42 cm（左宽，放按钮） |
| 舱门高 | 5.6 cm（铰链在 y=0.3） |
| 开门角度 | 52°（向后方掀起） |

## 五、来源

- [Polaroid i-Type Film — Wikipedia](https://en.wikipedia.org/wiki/Polaroid_i-Type_Film)
- [Polaroid i-Type Film Pack — polaroid.com](https://www.polaroid.com/products/i-type-film)
- [Polaroid i-Type Color Film — B&H Photo](https://www.bhphotovideo.com/c/product/1354034-REG/polaroid_6001_i_type_color_film.html)
- [Polaroid i-Type Film — Instant Film Review](https://www.instantfilmreview.com/polaroid-i-type-film)
- [Polaroid SX-70 — Wikipedia](https://en.wikipedia.org/wiki/Polaroid_SX-70)
- [Instant film formats — Wikipedia](https://en.wikipedia.org/wiki/Instant_film)
- 图片：Wikimedia Commons（CC0 / CC BY / CC BY-SA）；Polaroid 官方产品图（仅本地参考，未随项目发布）
