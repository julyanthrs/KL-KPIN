insert into categories (id, name, icon, sort) values
  ('animals', 'Animals', 'cat', 1),
  ('food', 'Food', 'strawberry', 2),
  ('nature', 'Nature', 'daisy', 3),
  ('cute', 'Cute Stuff', 'ribbon', 4),
  ('special', 'Special', 'sparkle', 5);

insert into pins (id, category_id, name, price_cents, stock, sort, active, bg, pat, pat_color) values
  ('puppy', 'animals', 'Puppy', 6000, 20, 0, true, '#fff4d6', 'dots', '#ffe6a8'),
  ('cat', 'animals', 'Sleepy Cat', 6000, 14, 1, true, '#e3f2ff', 'dots', '#c6e3ff'),
  ('strawberry', 'food', 'Strawberry', 5500, 24, 2, true, '#ffe3ea', 'dots', '#ffc6d5'),
  ('moon', 'nature', 'Moonbeam', 5500, 11, 3, true, '#4c5ba8', 'night', '#ffffff'),
  ('daisy', 'nature', 'Daisy', 4500, 28, 4, true, '#dff7e8', 'dots', '#c3edd3'),
  ('ribbon', 'cute', 'Ribbon', 5000, 18, 5, true, '#ffe8f2', 'checks', '#ffd3e6'),
  ('cloud', 'nature', 'Cloud Nap', 5000, 17, 6, true, '#cfe9ff', 'dots', '#b6dcff'),
  ('bear', 'animals', 'Honey Bear', 6000, 10, 7, true, '#fff1d9', 'stripes', '#ffe3b3'),
  ('star', 'special', 'Lucky Star', 5000, 25, 8, true, '#ece6ff', 'dots', '#d9ceff'),
  ('heart', 'cute', 'Heart', 4500, 30, 9, true, '#fff6c9', 'rays', '#ffeb98'),
  ('bunny', 'animals', 'Bun Bun', 6000, 16, 10, true, '#ffe3f0', 'checks', '#ffcde3'),
  ('cherry', 'food', 'Cherry Duo', 5000, 18, 11, true, '#fff0d6', 'checks', '#ffe2ad'),
  ('sun', 'nature', 'Sunny', 5500, 13, 12, true, '#fff3c4', 'rays', '#ffe68e'),
  ('ghost', 'cute', 'Ghostie', 6500, 2, 13, true, '#e8e0ff', 'stripes', '#d8ccff'),
  ('boba', 'food', 'Boba', 6000, 20, 14, true, '#e3f6ea', 'stripes', '#ccecd7'),
  ('frog', 'animals', 'Froggy', 5500, 22, 15, true, '#fff7d6', 'dots', '#ffeaa3'),
  ('peach', 'food', 'Peachy', 5000, 15, 16, true, '#fff1e6', 'dots', '#ffdcc4'),
  ('rainbow', 'special', 'Rainbow', 7000, 0, 17, true, '#fff0f5', 'dots', '#ffdbe8'),
  ('duck', 'animals', 'Ducky', 5500, 19, 18, true, '#dff5ff', 'rays', '#c8ecff'),
  ('donut', 'food', 'Donut', 5500, 12, 19, true, '#e8e4ff', 'dots', '#d5ccff');

insert into settings (id) values (1) on conflict (id) do nothing;
