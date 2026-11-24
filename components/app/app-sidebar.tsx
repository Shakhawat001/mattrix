"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { useTheme } from "next-themes"
import { TrendingUpIcon, SettingsIcon, MoonIcon, LogOutIcon, LayoutGridIcon, SunIcon } from "lucide-react"
import { logout } from "@/app/(auth)/login/actions"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { carriedQuery } from "@/lib/analytics/url"
import type { FilterApp } from "./filter-bar"

export function AppSidebar({ apps, brandName }: { apps: FilterApp[]; brandName: string }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { resolvedTheme, setTheme } = useTheme()
  // The range and comparison follow you from page to page.
  const carry = carriedQuery(searchParams)

  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-4">
        <Link href={`/${carry}`} className="flex items-center gap-2.5 outline-none">
          <span className="flex size-8 items-center justify-center bg-primary text-primary-foreground">
            <TrendingUpIcon strokeWidth={2.5} className="size-4" aria-hidden />
          </span>
          <span className="font-heading text-base font-semibold tracking-wider uppercase">{brandName}</span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Dashboard</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={pathname === "/"} render={<Link href={`/${carry}`} />}>
                  <LayoutGridIcon aria-hidden />
                  <span>All apps</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Apps</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {apps.length === 0 ? <li className="px-3 py-2 text-xs text-muted-foreground">No apps yet.</li> : null}
              {apps.map((app) => (
                <SidebarMenuItem key={app.id}>
                  <SidebarMenuButton isActive={pathname.startsWith(`/apps/${app.id}`)} render={<Link href={`/apps/${app.id}${carry}`} />}>
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: app.color }} aria-hidden />
                    <span>{app.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Manage</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={pathname.startsWith("/settings")} render={<Link href="/settings" />}>
                  <SettingsIcon aria-hidden />
                  <span>Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* Both icons are in the page; CSS picks one, so the server and browser agree. */}
            <SidebarMenuButton onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
              <SunIcon aria-hidden className="hidden dark:block" />
              <MoonIcon aria-hidden className="dark:hidden" />
              <span className="dark:hidden">Dark mode</span>
              <span className="hidden dark:inline">Light mode</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <form action={logout}>
              <SidebarMenuButton type="submit">
                <LogOutIcon aria-hidden />
                <span>Sign out</span>
              </SidebarMenuButton>
            </form>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
