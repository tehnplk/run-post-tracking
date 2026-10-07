-- 1 แถวใน Excel = 1 กล่อง (เลข EMS ไม่ซ้ำ)
CREATE TABLE parcel (
  ems            text PRIMARY KEY,        -- col E  เลขพัสดุ EMS
  recipient_name text NOT NULL,           -- col A  ชื่อผู้รับพัสดุ
  phone          text NOT NULL,           -- col B
  address        text NOT NULL,           -- col C
  piece_count    int  NOT NULL,           -- col F  จำนวนชิ้น
  sort_key       double precision         -- col G  คีย์เรียงกล่อง
);

-- 1 บรรทัดใน col D = 1 ชิ้น (BIB ไม่ซ้ำ) เช่น "3. M | BIB 3829 | mr ชื่อ นามสกุล | เดิน 5 กม."
CREATE TABLE item (
  bib       int  PRIMARY KEY,
  ems       text NOT NULL REFERENCES parcel(ems),
  line_no   int  NOT NULL,
  size      text NOT NULL,                -- XS..5XL, YS, YM ...
  title     text NOT NULL,                -- mr / miss / ms / boy / girl
  full_name text NOT NULL,                -- ชื่อ นามสกุล (ตัด zero-width space, ช่องว่างเหลือ 1)
  event     text NOT NULL                 -- เดิน 5 กม. / วิ่ง 10 กม. / ปั่น 20 กม.
);
CREATE INDEX item_ems_idx ON item(ems);
-- ponytail: ค้นด้วย ILIKE '%..%' แบบ seq scan, 6k แถวเร็วพอ; ถ้าเกินแสนแถวค่อยเพิ่ม pg_trgm GIN index
