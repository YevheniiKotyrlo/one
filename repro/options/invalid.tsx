import { Stack, Tabs } from 'one'

export function TabsLayout() {
  return (
    <Tabs screenOptions={{ notATabsOption: true }}>
      <Tabs.Screen name="index" options={{ notATabsOption: true }} />
      <Tabs.Screen name="settings" options={{ tabBarIcon: 42 }} />
    </Tabs>
  )
}

export function StackLayout() {
  return (
    <Stack screenOptions={{ notAStackOption: true }}>
      <Stack.Screen name="index" options={{ notAStackOption: true }} />
    </Stack>
  )
}
